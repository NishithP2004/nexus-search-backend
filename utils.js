const {
    NodeHtmlMarkdown
} = require('node-html-markdown');
const puppeteer = require('puppeteer');

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
const {
    RunnableWithMessageHistory
} = require("@langchain/core/runnables")
const {
    UpstashRedisChatMessageHistory
} = require("@langchain/community/stores/message/upstash_redis");
const {
    ChatPromptTemplate,
    MessagesPlaceholder,
} = require("@langchain/core/prompts");

const Sitemapper = require('sitemapper');
const sitemapper = new Sitemapper();
const robotsParser = require('robots-txt-parser');
const robots = robotsParser({
    userAgent: 'Googlebot', // The default user agent to use when looking for allow/disallow rules, if this agent isn't listed in the active robots.txt, we use *.
    allowOnNeutral: false // The value to use when the robots.txt rule's for allow and disallow are balanced on whether a link can be crawled.
});

const {
    client
} = require("./cache")

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

async function fetchUrlsFromSitemap(url) {
    try {
        sitemapper.timeout = 60 * 1000;
        let sitemap = sitemapper.fetch(url + '/sitemap.xml')
            .then(({
                url,
                sites
            }) => sites)
            .catch(err => {
                throw err
            })

        return sitemap
    } catch (err) {
        throw err;
    }
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
            type: "stuff"
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
        throw err.message;
    }
}

const statusCode = async (url) => {
    let res = await fetch(url)
    return res.status;
}

function sanitiseURL(url) {
    let t = new URL(url);
    let u = `${t.protocol}//${t.hostname}${(t.port)? `:${t.port}`: ""}${t.pathname}`

    return (u.endsWith("/")) ? u.slice(0, -1) : u;
}

const visitPage = async (url) => {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox'],
        headless: "new"
    })
    try {
        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: "networkidle0"
        });
        const content = await page.evaluate(() => document.body.innerHTML);
        const webpage = new Webpage();
        const status = await statusCode(url);
        webpage.url = sanitiseURL(url);
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
            webpage.links = Array.from(new Set(links.map(link => sanitiseURL(link)).filter((link) => link.includes(hostname) == true)));

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

async function getWebsiteContent(url) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox'],
        headless: "new"
    })
    try {
        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: "networkidle0"
        });
        const content = await page.evaluate(() => document.body.innerHTML);
        let pageContent = covertHtmlToMd(content);
        return pageContent;
    } catch (err) {
        if (err)
            throw err
    } finally {
        await browser.close();
    }
}

async function generativeAISearchResults(query, sources, continuedConversation = false, sessionId = "foobarz") {
    try {
        let context;
        if (!continuedConversation) {
            context = await Promise.all(sources.map(async sr => {
                return ({
                    url: sr.url,
                    title: sr.title,
                    content: ((await client.exists(sr.url)) ? await client.get(sr.url) : await getWebsiteContent(sr.url).then(content => {
                        client.set(sr.url, content, {
                            EX: 60 * 5
                        });
                        return content;
                    }))
                })
            }));
        }

        const prompt = `
        ${!continuedConversation? `
        SYSTEM: As a knowledgeable question-answering AI, you can utilize the markdown content from various websites which is provided as your context to provide relevant and descriptive and elaborate answers to the user's queries. 
                By analyzing the information provided in the content, you can generate accurate responses tailored to your needs.`: ""}
        QUERY: {query}

        ${!continuedConversation? 
        `CONTEXT
        ------
        ${context.map((c, i) => `Website ${i+1} (${c.title} - ${c.url}): \n${c.content}`).join("\n")}`: ""}
        `
        console.log(prompt.trim())
        const chatPrompt = ChatPromptTemplate.fromMessages([
            new MessagesPlaceholder("history"),
            ["human", prompt.trim()]
        ]);

        const chain = chatPrompt.pipe(model);
        const chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (sessionId) =>
                new UpstashRedisChatMessageHistory({
                    sessionId,
                    sessionTTL: 300,
                    config: {
                        url: process.env.UPSTASH_REDIS_HOST,
                        token: process.env.UPSTASH_REDIS_TOKEN,
                    },
                }),
            inputMessagesKey: "query",
            historyMessagesKey: "history"
        });

        const res = (await chainWithHistory.invoke({
            query
        }, {
            configurable: {
                sessionId: sessionId
            }
        })).content;

        return res;
    } catch (err) {
        throw err;
    }
}

module.exports = {
    visitPage,
    covertHtmlToMd,
    Webpage,
    sanitiseURL,
    model,
    embeddings,
    fetchUrlsFromSitemap,
    robots,
    generativeAISearchResults
}