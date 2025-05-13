import express from "express"
import http from 'http'
import {
    instrument
} from "@socket.io/admin-ui";
import { Server } from "socket.io"
import "dotenv/config";
import {
    generativeAISearchResults
} from "./utils.js";

import {
    getSearchResults
} from "./services/neo4j.js"
import { sendMessage } from "./services/kafka.js";

const app = express();
app.use(express.json())
app.use(express.urlencoded({
    extended: true
}))
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

const io = new Server(server, {
    cors: ["https://admin.socket.io"],
    credentials: true,
    maxHttpBufferSize: 1e8,
});

instrument(io, {
    mode: "development",
    auth: false,
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on port: ${PORT}`);
})

app.get("/", (req, res) => {
    res.send({
        message: "Welcome to Nexus Search Backend!",
        success: true
    })
})


app.post("/crawl", async (req, res) => {
    let url = req.body.url;
    const options = req.query;

    if (!url) {
        res.status(400).send({
            error: "Invalid URL",
            success: false
        })
    } else {
        await sendMessage({
            topic: "init_crawl",
            data: {
                url,
                options
            }
        })

        res.sendStatus(204)
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