import { client as redis } from "./services/redis.js"
import { sendMessage } from "./services/kafka.js"
import "dotenv/config";
import {
    Worker
} from "node:worker_threads";
import os from "node:os";
import {
    sanitiseURL,
    fetchUrlsFromSitemap,
    robots,
    sleep
} from "./utils.js";

import {
    insertNodes
} from "./services/neo4j.js"
import { randomBytes } from "node:crypto";
import AsyncLock from "async-lock"

const threadCount = parseInt(process.env.THREADS) || os.availableParallelism();
const threads = new Set();

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || threadCount || 5
const key = `${os.hostname()}#${process.pid}_crawl_lock`

const lock = new AsyncLock()

function createWorkerPromise(workerData) {
    return new Promise((resolve, reject) => {
        const visitedNodes = []

        const worker = new Worker('./worker.js', {
            workerData
        });

        console.log("Spawned Worker %d", worker.threadId);
        threads.add(worker);
        worker.on('message', (msg) => {
            if (msg.success) {
                console.log("Visited: " + msg.url);
                if(msg && msg.url) 
                    visitedNodes.push(msg);
            } else {
                console.error("Error: " + msg.error);
            }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            threads.delete(worker);
            if (code !== 0) {
                reject(new Error(`Worker ${worker.threadId} stopped with exit code ${code}`));
            } else {
                console.log(`Worker ${worker.threadId} stopped with exit code ${code}`)
                resolve(visitedNodes)
            }
            console.log("%d threads running...", threads.size)
        });
    });
}

async function handleMessage(topic, data) {
    if (topic === "init_crawl") {
        const { url, options } = data;

        let sanitisedUrl = sanitiseURL(url)

        const urls = []
        urls.push(sanitisedUrl)

        if (options.sitemap == "true") {
            let sitemap = await fetchUrlsFromSitemap(sanitisedUrl);
            if (sitemap.length > 0) {
                urls.push(...sitemap);
            }
            console.log("The sitemap contains %d URLs", sitemap.length)
        }

        const taskId = randomBytes(4).toString("hex")
        console.log("Creating Task...")

        await sendMessage({
            topic: "crawl_links",
            data: {
                taskId,
                baseUrl: sanitisedUrl,
                links: urls
            }
        })
        console.log("Task Created...")
    } else if (topic === "crawl_links") {
        const { taskId, baseUrl, links } = data;
        await robots.useRobotsFor(baseUrl)

        const filteredLinks = Array.from(new Set(links)).filter(link => robots.canCrawlSync(link)).map(link => sanitiseURL(link))
        console.log(filteredLinks)

        for (let i = 0; i < filteredLinks.length; i++) {
            const linksToVisit = filteredLinks.splice(0, BATCH_SIZE)

            await sendMessage({
                topic: "crawl_links_batch",
                data: {
                    taskId,
                    baseUrl,
                    linksToVisit
                }
            })
            await sleep(2.5) // Small Delay 
        }
    } else if (topic === "crawl_links_batch") {
        const { taskId, baseUrl, linksToVisit } = data

        lock.acquire(key, async () => {
            for (let link of linksToVisit) {
                if ((await redis.sIsMember(`tasks:${taskId}:visitedLinks`, link)))
                    linksToVisit.splice(linksToVisit.indexOf(link), 1)
            }

            console.log("Filtered links to visit:", linksToVisit)

            const visitedNodes = await createWorkerPromise({
                linksToVisit
            })

            const newLinks = []
            for (let visited of visitedNodes) {
                if (visited?.success == true) {
                    delete visited.success;
                    await redis.sAdd(`tasks:${taskId}:visitedLinks`, visited.url)
                    if(visited?.links?.length > 0) 
                        newLinks.push(...visited.links)
                }
            }

            if(newLinks.length > 0) {
                await sendMessage({
                topic: "crawl_links",
                data: {
                    taskId,
                    baseUrl,
                    links: newLinks
                }
            })
            }

            await sleep(1)

            if(visitedNodes?.length > 0) {
                await sendMessage({
                topic: "insert_nodes",
                data: {
                    taskId,
                    baseUrl,
                    nodes: visitedNodes
                }
            })
            }
        })
    } else if (topic === "insert_nodes") {
        const { taskId, baseUrl, nodes } = data

        if(nodes.length > 0) {
            console.log(`Task #${taskId} - Inserting Nodes...`)
            await insertNodes(nodes.filter((p) => Object.keys(p).length > 0))
            console.table(nodes)

            await redis.expire(`tasks:${taskId}:visitedLinks`, 3600) // TTL: 1 hr
        }
    }
}

export {
    handleMessage
}