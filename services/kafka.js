import {
    Kafka
} from "kafkajs";
import ip from "ip"
import "dotenv/config"
import { handleMessage } from "../messageHandler.js";

const HOST_IP = process.env.HOST_IP || ip.address()
const mode = process.env.MODE || "DEV"

const kafka = new Kafka({
    clientId: "nexus-search",
    brokers: [(mode === "PROD")? "kafka:9092": `${HOST_IP}:9092`]
})

const producer = kafka.producer()
const consumer = kafka.consumer({
    groupId: "nexus-consumer-group-0"
})

const topics = ["init_crawl", "crawl_links", "crawl_links_batch", "insert_nodes"]

async function sendMessage(message) {
    const {
        topic,
        data
    } = message
    const metadata = await producer.send({
        topic,
        messages: [{
            value: JSON.stringify(data)
        }]
    })

    return metadata
}

const initKafka = async () => {
    await producer.connect()

    await consumer.connect()
    await consumer.subscribe({
        topics
    })

    await consumer.run({
        eachMessage: async ({
            topic,
            partition,
            message
        }) => {
            const data = JSON.parse(message.value.toString())
            console.log({
                topic,
                partition,
                offset: message.offset,
                value: data
            })

            handleMessage(topic, data)
        }
    })
}

export {
    sendMessage,
    initKafka
}