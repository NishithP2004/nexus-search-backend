const {
    NodeHtmlMarkdown
} = require('node-html-markdown');
const puppeteer = require('puppeteer');
const fs = require("node:fs")
const {
    ChatGoogleGenerativeAI,
    GoogleGenerativeAIEmbeddings
} = require("@langchain/google-genai");
const {
    loadSummarizationChain
} = require("langchain/chains")
const {
    Document
} = require('langchain/document');
const {
    RecursiveCharacterTextSplitter
} = require('langchain/text_splitter')

require("dotenv").config()

const model = new ChatGoogleGenerativeAI({
    modelName: "gemini-pro",
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.7
});

const embeddings = new GoogleGenerativeAIEmbeddings({
    modelName: "embedding-001",
    apiKey: process.env.GEMINI_API_KEY
})

class Webpage {
    url = "";
    status = 200;
    title = "";
    links = [];
    redirects = [];
    is_404 = false;
    keywords = [];
    embeddings = [];
    summary = "";
}

const covertHtmlToMd = (html) => {
    const md = NodeHtmlMarkdown.translate(html);
    return md;
}

async function extract_keywords(documents) {
    let keywords = [];

    try {
        for (let document of documents) {
            try {
                let prompt = `
                    SYSTEM: You are an intelligent Web Crawler bot which can extract the essential keywords from a given text which represents the website content and return the same as a comma separated list.
                        For example, 
                        input: Broadcom agreed to acquire cloud computing company VMware in a $61 billion (€57bn) cash-and stock deal.
                        output: cloud computing, broadcom, vmware

                        The output format will always be keyword1, keyword2, ...

                    INPUT TEXT: ${document.pageContent}
            `

                let res = (await model.invoke([
                    ["human", prompt]
                ])).content;
                let k = res.split(",").map(keyword => keyword.trim())
                keywords.push(...k);
            } catch (err) {
                continue;
            }
        }

        return Array.from(new Set(keywords));
    } catch (err) {
        throw err;
    }
}

async function generateEmbeddings(text) {
    try {
        return (await embeddings.embedQuery(text))
    } catch (err) {
        throw err;
    }
}

const processPage = async (text) => {
    try {
        const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
            chunkSize: 10000
        });

        const documents = await splitter.createDocuments([text])
        console.log("Documents: %d", documents.length)
        const keywords = (text.length > 0) ? await extract_keywords(documents) : [];
        console.log("Keywords: " + keywords.join(", "))

        // Generating a summary
        const chain = loadSummarizationChain(model, {
            type: "map_reduce"
        })

        const summary = (await chain.call({
            input_documents: documents
        })).text

        const embeddings = await generateEmbeddings(summary);
        console.log("Embeddings Generated Successfully")

        return {
            keywords,
            embeddings,
            summary
        }
    } catch (err) {
        throw err;
    }
}

const statusCode = async (url) => {
    let res = await fetch(url)
    return res.status;
}

function processURL(url) {
    let t = new URL(url);
    let u = `${t.protocol}//${t.hostname}${(t.port)? `:${t.port}`: ""}${t.pathname}`

    return (u.endsWith("/")) ? u.slice(0, -1) : u;
}

const visitPage = async (url) => {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox'],
        headless: false
    })
    try {
        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: "networkidle0"
        });
        const content = await page.evaluate(() => document.body.innerHTML);
        const webpage = new Webpage();
        const status = await statusCode(url);
        webpage.url = processURL(url);
        webpage.status = status;

        const hostname = new URL(url).hostname;

        if (status == 301 || status == 302) {
            webpage.redirects.push(page.url());
        } else if (status == 404) {
            webpage.is_404 = true;
        } else {
            let pageContent = covertHtmlToMd(content);
            webpage.title = await page.title();
            const body = await page.$('body');

            const links = await page.evaluate(el => {
                // Preliminary Processing
                let blacklist = /(youtube\.com|facebook\.com|twitter\.com|x\.com|linkedin\.com|snapchat\.com|instagram\.com|github\.com|javascript:void\(0\)|cloudfront\.net|wp-content|mailto|tel|(\w+\.(pdf|png|jpg|jpeg|docx|json|txt|gif|svg|mp4|mp3)))/i;
                let links = Array.from(el.getElementsByTagName("a"));
                links = links.map(a => (a.href.endsWith("/")) ? a.href.slice(0, -1) : (a.href.endsWith("/#") ? a.href.slice(0, -2) : (a.href.includes("#")) ? a.href.split("#")[0] : a.href)).filter(href => href !== '' && blacklist.test(href) === false)
                return links;
            }, body)

            // Secondary Processing
            webpage.links = Array.from(new Set(links.map(link => processURL(link)).filter((link) => link.includes(hostname) == true)));

            await browser.close();

            const {
                keywords,
                embeddings,
                summary
            } = await processPage(pageContent);
            webpage.keywords = keywords;
            webpage.embeddings = embeddings;
            webpage.summary = summary;

            return webpage;
        }
    } catch (err) {
        if (err)
            throw err
    } finally {
        await browser.close();
    }
}

const main = async () => {
    let t1 = performance.now();
    const data = await visitPage("https://google.com/");
    let t2 = performance.now();
    console.log("Total Execution Time: %d ms", t2 - t1)
    fs.writeFileSync("output.json", JSON.stringify(data, null, 2))
}

// main();

module.exports = {
    visitPage,
    covertHtmlToMd,
    Webpage,
    processURL
}