const express = require("express")
const http = require('http')
const {
    instrument
} = require("@socket.io/admin-ui");
require("dotenv").config();
const {
    Worker
} = require("node:worker_threads");
const os = require("node:os");
const {
    sanitiseURL,
    fetchUrlsFromSitemap,
    robots,
    generativeAISearchResults
} = require("./utils");
// const fs = require("node:fs")
const {
    insertNodes,
    getSearchResults
} = require("./database")

const app = express();
app.use(express.json())
app.use(express.urlencoded({
    extended: true
}))
const PORT = process.env.PORT || 3000;

const threadCount = process.env.THREADS || os.availableParallelism();
var threads = new Set();

const server = http.createServer(app);

const io = require("socket.io")(server, {
    cors: ["https://admin.socket.io"],
    credentials: true,
    maxHttpBufferSize: 1e8,
});

instrument(io, {
    mode: "development",
    auth: false,
});

server.listen(PORT, () => {
    console.log(`Listening on port: ${PORT}`);
})

app.get("/", (req, res) => {
    res.send({
        message: "Hello World",
        success: true
    })
})

function createWorkerPromise(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./worker.js', {
            workerData
        });

        console.log("Spawned Worker %d", worker.threadId);
        threads.add(worker);
        worker.on('message', (msg) => {
            if (msg.success) {
                console.log("Visited: " + msg.url);
                resolve(msg);
            } else {
                console.log("Error: " + msg.error);
                reject(new Error(msg.error));
            }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            threads.delete(worker);
            if (code !== 0) {
                reject(new Error(`Worker ${worker.threadId} stopped with exit code ${code}`));
            } else {
                console.log(`Worker ${worker.threadId} stopped with exit code ${code}`)
            }
            console.log("%d threads running...", threads.size)
        });
    });
}


app.post("/crawl", async (req, res) => {
    let url = req.body.url;
    const options = req.query;
    const MAX_PAGES = options.max_pages || process.env.MAX_PAGES || 25;

    await robots.useRobotsFor(url)

    try {
        if (!url) {
            res.status(400).send({
                error: "Invalid URL",
                success: false
            })
        } else {
            url = sanitiseURL(url)
            res.sendStatus(204);
            const alreadyVisited = [];
            let current = [url];

            // Pre-fetch
            if (options.sitemap == "true") {
                let sitemap = await fetchUrlsFromSitemap(url);
                (sitemap.length > 0) ? current.push(...sitemap): null;
                console.log("The sitemap contains %d URLs", sitemap.length)
            }

            while (current.length > 0 && alreadyVisited.length < MAX_PAGES) {
                for (let i = 0; i < threadCount - 1; i++) {
                    const linksToVisit = current.splice(0, 5).filter(link => !alreadyVisited.find(l => l.url === link) && robots.canCrawlSync(link));

                    if (linksToVisit.length > 0) {
                        console.log("Links To Visit: ");
                        console.log(linksToVisit)
                        const visited = await createWorkerPromise({
                            linksToVisit
                        })

                        if (!alreadyVisited.find(page => page.url === visited.url) && typeof visited === 'object' && visited ?.success === true) {
                            console.log("Visited Links: ");
                            delete visited.success;
                            console.log(visited)
                            alreadyVisited.push(visited);
                        }

                        console.log("Already visited: ");
                        console.table(alreadyVisited)
                        if (visited && visited.hasOwnProperty("links") && visited.links.length > 0 && options.sitemap == false)
                            current.push(...visited.links)

                        current = Array.from(new Set(current));
                        console.log("Current Length: %d", current.length)
                    }

                }

                if (current.length === 0 || alreadyVisited.length >= MAX_PAGES || threads.size == 0) {
                    console.log("Task Completed 🎉")
                    // Terminate all active worker threads
                    threads.forEach(worker => worker.terminate());
                    threads.clear(); // Clear the Set of workers
                    if (alreadyVisited.length > 0) {
                        // fs.writeFileSync("output.json", JSON.stringify(alreadyVisited, null, 2));
                        await insertNodes(alreadyVisited.filter((p) => Object.keys(p).length > 0))
                    } else
                        console.log("Empty Array");
                    break;
                }
            }
        }
    } catch (err) {
        console.error("Task Failed: " + err.message);
    }
})

app.get("/search", async (req, res) => {
    const query = req.query.q;
    const cookies = req.headers['cookie']
    .split(";")
    .filter(c => c.trim() !== '') 
    .reduce((p, c) => {
        let [key, value] = c.split("=");
        p[key.trim()] = value ? value.trim() : '';
        return p; 
    }, {});
    console.log("session: " + cookies.session)

    try {
        if (!query) {
            res.status(400).send({
                error: "Search Query missing",
                success: false
            })
        } else {
            let search_results = await getSearchResults(query);

            res.status(200).send({
                success: true,
                results: search_results
            })
        }
    } catch (err) {
        if (err) {
            res.status(500).send({
                error: err.message,
                success: false
            })
        }
    }
})

io.on('connection', (client) => {
    console.log(`Connected to ${client.id}`);

    client.on("user-message", async data => {
        try {
            // Chat using Message History
            let answer = await generativeAISearchResults(data.query, data.sources, data.session);
            io.to(client.id).emit("bot-response", ({
                answer,
                success: true
            }))
        } catch (err) {
            if (err) {
                io.to(client.id).emit("bot-response", ({
                    answer: err.message,
                    success: false
                }))
            }
        }
    })
})