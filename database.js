const neo4j = require('neo4j-driver');
const {
    Neo4jVectorStore
} = require("@langchain/community/vectorstores/neo4j_vector")

const {
    model,
    embeddings
} = require('./utils')
require("dotenv").config()

const URI = process.env.NEO4J_URI
const USERNAME = process.env.NEO4J_USERNAME
const PASSWORD = process.env.NEO4J_PASSWORD
const driver = neo4j.driver(URI, neo4j.auth.basic(USERNAME, PASSWORD));
const session = driver.session()

const CYPHER_INSERT_QUERY =
    `
    UNWIND $webpages AS webpage

    MERGE (w:Webpage {url: webpage.url})
    ON CREATE SET 
        w.status = webpage.status,
        w.title = webpage.title,
        w.is_404 = webpage.is_404,
        w.keywords = webpage.keywords,
        w.embeddings = webpage.embeddings,
        w.summary = webpage.summary
    ON MATCH SET 
        w.status = webpage.status,
        w.title = webpage.title,
        w.is_404 = webpage.is_404,
        w.keywords = webpage.keywords,
        w.embeddings = webpage.embeddings,
        w.summary = webpage.summary
    
    WITH w, webpage
    UNWIND webpage.links AS link
    MERGE (l:Webpage {url: link})
    MERGE (w)-[:LINKS_TO]->(l)
    
    WITH w, webpage
    UNWIND webpage.redirects AS redirect
    MERGE (r:Webpage {url: redirect})
    MERGE (w)-[:REDIRECTS_TO]->(r)
    
    WITH w, webpage
    UNWIND webpage.keywords AS keyword
    MERGE (k:Keyword { keyword: keyword })
    MERGE (w)-[:HAS_KEYWORD]->(k)
`;

/* const CYPHER_KEYWORD_OR_TITLE_SEARCH_QUERY =
    `
MATCH (n)
  WHERE ANY(keyword IN n.keywords WHERE keyword IN $keywords)
  OR ANY(keyword IN $keywords WHERE n.title CONTAINS keyword)
  RETURN n LIMIT 5
`

async function extract_keywords(text) {
    let keywords = [];

    try {
        let prompt = `
                    SYSTEM: You are an intelligent keyword extractor bot which can extract the essential keywords from a given text and return the same as a comma separated list.
                        For example, 
                        input: Broadcom agreed to acquire cloud computing company VMware in a $61 billion (€57bn) cash-and stock deal.
                        output: cloud computing, broadcom, vmware

                        The output format will always be keyword1, keyword2, ...

                    INPUT TEXT: ${text}
            `

        let res = (await model.invoke([
            ["human", prompt]
        ])).content;

        let k = res.split(",").map(keyword => keyword.trim())
        keywords.push(...k);

        return Array.from(new Set(keywords));
    } catch (err) {
        console.error(err)
        return [];
    }
}

async function keywordBasedSearch(keywords) {
    let records = session
        .run(CYPHER_KEYWORD_OR_TITLE_SEARCH_QUERY, {
            keywords: keywords
        })
        .then(result => {
            const records = result.records?.map(record => record.toObject().n.properties) || [];
            return records.slice(0, Math.min(5, records.length)).map(record => {
                return {
                    url: record.url,
                    title: record.title,
                    summary: record.summary
                }
            })
        })
        .catch(err => {
            console.error(err.message);
            return []
        })

    return records
} */

async function insertNodes(nodes) {
    session
        .run(CYPHER_INSERT_QUERY, {
            webpages: nodes
        })
        .then(result => {
            console.log("Webpages Inserted");
            console.log(result)
        })
        .catch(err => {
            throw err
        })
};

function convertDocPageContentToJSON(pageContent, score) {
    let regex = /(\nurl:\s[a-z0-9A-Z://\.]+)|(\ntitle:\s[\w\d\s\W]+\n)|(keywords:\s(,[\w\d\s\W]+)+)/g;
    let matches = pageContent.match(regex).map(str => str.slice(str.indexOf(":", 0) + 1).trim());

    return {
        url: matches[0].trim(),
        title: matches[1].slice(0, matches[1].lastIndexOf("\nsummary: ")).replaceAll("\n", ""),
        summary: matches[1].slice(matches[1].lastIndexOf("\nsummary: ") + 9).trim().replaceAll("\n", ""),
        keywords: matches[2].slice(1),
        favicon: `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${matches[0].trim()}&size=64`,
        score: score
    }

}
async function getSearchResults(query) {
    try {
        // Stage 1
        const neo4jVectorIndex = await Neo4jVectorStore.fromExistingGraph(embeddings, {
            url: URI,
            username: USERNAME,
            password: PASSWORD,
            indexName: "webpage-embeddings",
            embeddingNodeProperty: "embeddings",
            searchType: 'vector',
            textNodeProperties: ["url", "title", "summary", "keywords"]
        })

        const results = [];

        results.push(...(await neo4jVectorIndex.similaritySearchWithScore(query, 10)).map(doc => {
            return convertDocPageContentToJSON(doc[0].pageContent, doc[1])
        }))

        /* // Stage 2
        let keywords = await extract_keywords(query);
        if (keywords.length > 0) {
            let records = await keywordBasedSearch(keywords);
            (records.length > 0) ? results.push(...records): null;
        }

        let uniqUrls = new Set(results.map(r => r.url));
        return Array.from(uniqUrls).map(u => results.find(r => r.url === u)) */
        
        return results
    } catch (err) {
        throw err;
    }
}

module.exports = {
    driver,
    insertNodes,
    getSearchResults
}