import "dotenv/config"
import morgan from "morgan"
import twilio from "twilio"
import express from "express"
import whisper from "node-whisper"
import {
    randomBytes
} from "node:crypto"
import {
    searchOnCall
} from "../utils.js"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { sleep } from "../utils.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express.Router();

app.use(express.json())
app.use(express.urlencoded({
    extended: true
}))
app.use(morgan(":method :url :status - :remote-addr"));

let details = await client.balance.fetch();
console.log("Account sid: %s\nBalance: %f %s", details.accountSid, details.balance, details.currency)

const base64Auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64")

app.post("/call", async (req, res) => {
    try {
        const ph = req.body.ph;
        const call = await client.calls.create({
            to: ph,
            from: process.env.TWILIO_PHONE_NUMBER,
            sendDigits: "w",
            url: `${process.env.HOST_URL}/twilio/greeting`,
            // statusCallback: `${process.env.HOST_URL}/twilio/status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["initiated", "answered", "completed"]
        })

        console.log("Call Initiated: %s", call.sid);

        res.status(201).send({
            success: true,
            sid: call.sid
        })
    } catch (err) {
        res.status(500).send({
            error: err.message,
            success: false
        })
    }
})

app.post("/greeting", (req, res) => {
    console.log(req.body)
    const twiml = new VoiceResponse();

    twiml.say({
        voice: "alice"
    }, "Hi there! You’ve reached Nexus — your voice-powered search assistant. After the beep, ask your question, then press the pound key to finish.")

    twiml.record({
        action: "/twilio/search",
        method: "POST",
        maxLength: "30",
        finishOnKey: "#"
    })

    twiml.say({
        voice: "alice"
    }, "We did not receive a recording. Goodbye.")

    res.type("text/xml")

    res.send(twiml.toString());
})

app.post("/search", async (req, res) => {
    try {
        console.log(req.body)
        res.type("text/xml")
        const twiml = new VoiceResponse()
        twiml.play(`${process.env["HOST_URL"]}/twilio/bgm.mp3`)
        twiml.play(`${process.env["HOST_URL"]}/twilio/bgm.mp3`)
        res.send(twiml.toString())

        const recordingUrl = req.body["RecordingUrl"];
        console.log(recordingUrl)
        await sleep(5)
        const filename = await downloadRecording(recordingUrl)
        const query = await transcribeAudio(filename)
        console.log("Query:", query)
        const answer = await searchOnCall(query, req.body.CallSid)

        const updatedTwiml = new VoiceResponse()
        updatedTwiml.say(answer)

        updatedTwiml.record({
            action: "/twilio/search",
            method: "POST",
            maxLength: "30",
            finishOnKey: "#"
        })

        updatedTwiml.say({
            voice: "alice"
        }, "We did not receive a recording. Goodbye.")

        await updateCallContext(req.body.CallSid, updatedTwiml.toString())
        await fs.unlink(`temp/${filename}.mp3`)
    } catch (err) {
        console.error(err)
    }
})

app.get("/bgm.mp3", (req, res) => {
    const __parentdir = dirname(__dirname)
    res.sendFile(join(__parentdir, "bgm.mp3"))
})

async function downloadRecording(url) {
    try {
        const hash = randomBytes(4).toString("hex");

        const response = await fetch(url, {
            headers: {
                Authorization: `Basic ${base64Auth}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch recording: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer(); 
        const fileBuffer = Buffer.from(buffer); 
        if(!existsSync("temp")) {
            await fs.mkdir("temp")
        }

        const filePath = `temp/${hash}.mp3`;
        await fs.writeFile(filePath, fileBuffer);

        console.log(`Recording saved as ${filePath}`);
        return hash;
    } catch (err) {
        console.error("Error downloading recording:", err.message);
        throw err;
    }
}

async function transcribeAudio(filename) {
    try {
        const data = await whisper(`temp/${filename}.mp3`, {
            model: "turbo",
            verbose: false,
            output_format: "txt",
            output_dir: "temp/transcript"
        })

        return data.txt.getContent()
    } catch (err) {
        console.error(`Error transcribing audio (${filename}.mp3):`, err.message)
        throw err
    }
}

async function updateCallContext(CallSid, xmlScript) {
    return client.calls.get(CallSid).update({
            twiml: xmlScript
        })
        .then(call => console.log(`Call updated with new script: ${call.sid}`))
        .catch(err => console.error(err))
}

export default app;