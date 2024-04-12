const express = require("express")
require("dotenv").config();
const {
    Worker
} = require("worker_threads");
const os = require("node:os");
const {
    processURL
} = require("./utils");
const fs = require("node:fs")

const app = express();
app.use(express.json())
app.use(express.urlencoded({
    extended: true
}))
const PORT = process.env.PORT || 3000;

const threadCount = process.env.THREADS || os.availableParallelism();
var threads = new Set();

app.listen(PORT, () => {
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
    const MAX_PAGES = req.body.max_pages || process.env.MAX_PAGES || 25;

    if (!url) {
        res.status(400).send({
            error: "Bad Request",
            success: false
        })
    } else {
        url = processURL(url)
        res.sendStatus(204);
        const alreadyVisited = [];
        let current = [url];

        while ((current.length > 0) && alreadyVisited.length < MAX_PAGES) {
            for (let i = 0; i < threadCount - 1; i++) {
                const linksToVisit = current.splice(0, 5).filter(link => !alreadyVisited.find(l => l.url === link));
                if (linksToVisit.length > 0) {
                    console.log("Links To Visit: ");
                    console.log(linksToVisit)
                    const visited = await createWorkerPromise({
                        linksToVisit
                    })

                    if (!alreadyVisited.find(page => page.url === visited.url) && typeof visited === 'object' && visited?.success === true) {
                        console.log("Visited Links: ");
                        delete visited.success;
                        console.log(visited)
                        alreadyVisited.push(visited);
                    }

                    console.log("Already visited: ");
                    console.table(alreadyVisited)
                    if (visited && visited.hasOwnProperty("links") && visited.links.length > 0)
                        current.push(...visited.links)

                    current = Array.from(new Set(current));
                    console.log("Current Length: %d", current.length)
                }

            }
            if (current.length === 0 || alreadyVisited.length >= MAX_PAGES || threads.size == 0) {
                fs.writeFileSync("output.json", JSON.stringify(alreadyVisited, null, 2));
                break;
            }
        }
    }
})