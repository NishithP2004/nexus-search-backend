import neo4j from 'neo4j-driver';
import {
    Neo4jVectorStore
} from "@langchain/community/vectorstores/neo4j_vector"

import {
    model,
    embeddings
} from '../utils.js'
import "dotenv/config"

const URI = process.env.NEO4J_URI
const USERNAME = process.env.NEO4J_USERNAME
const PASSWORD = process.env.NEO4J_PASSWORD
const driver = neo4j.driver(URI, neo4j.auth.basic(USERNAME, PASSWORD));
const session = driver.session()

const CYPHER_INSERT_QUERY = `
    UNWIND $webpages AS webpage

    MERGE (w:Webpage {url: webpage.url})
    SET 
        w.status = webpage.status,
        w.title = webpage.title,
        w.is_404 = webpage.is_404,
        w.keywords = webpage.keywords,
        w.embeddings = webpage.embeddings,
        w.summary = webpage.summary

    FOREACH (link IN coalesce(webpage.links, []) | 
        MERGE (l:Webpage {url: link})
        MERGE (w)-[:LINKS_TO]->(l)
    )

    FOREACH (redirect IN coalesce(webpage.redirects, []) | 
        MERGE (r:Webpage {url: redirect})
        MERGE (w)-[:REDIRECTS_TO]->(r)
    )

    FOREACH (keyword IN coalesce(webpage.keywords, []) | 
        MERGE (k:Keyword {keyword: keyword})
        MERGE (w)-[:HAS_KEYWORD]->(k)
    )
`;

const CYPHER_KEYWORD_SEARCH_QUERY =
    `
    WITH $keywords AS keywords
    MATCH (w:Webpage)
    WHERE 
      ANY(keyword IN keywords WHERE 
        toLower(w.title) CONTAINS toLower(keyword) OR 
        ANY(k IN w.keywords WHERE toLower(k) CONTAINS toLower(keyword)) OR 
        toLower(w.summary) CONTAINS toLower(keyword)
      )
    WITH w, keywords,
      REDUCE(score = 0, keyword IN keywords | 
        score +
        CASE 
          WHEN toLower(w.title) CONTAINS toLower(keyword) THEN 1 ELSE 0 
        END +
        CASE 
          WHEN ANY(k IN w.keywords WHERE toLower(k) CONTAINS toLower(keyword)) THEN 1 ELSE 0 
        END +
        CASE 
          WHEN toLower(w.summary) CONTAINS toLower(keyword) THEN 1 ELSE 0 
        END
      ) AS score
    RETURN w, score
    ORDER BY score DESC
    LIMIT 10
    
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
        .run(CYPHER_KEYWORD_SEARCH_QUERY, {
            keywords: keywords
        })
        .then(result => {
            const records = result.records?.map(record => record.toObject().w.properties) || [];
            return records.map(record => { 
                return {
                    url: record.url,
                    title: record.title,
                    summary: record.summary,
                    favicon: `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${record.url}&size=64`,
                }
            })
        })
        .catch(err => {
            console.error(err.message);
            return []
        })

    return records
} 

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
        // keywords: matches[2].slice(1),
        favicon: `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${matches[0].trim()}&size=64`,
        score: score
    }

}
async function getSearchResults(query) {
    try {
        let response = {}
        let t1, t2, t3, t4;
        // Stage 1
        t1 = performance.now();
        const neo4jVectorIndex = await Neo4jVectorStore.fromExistingGraph(embeddings, {
            url: URI,
            username: USERNAME,
            password: PASSWORD,
            indexName: "webpage-embeddings",
            embeddingNodeProperty: "embeddings",
            searchType: 'vector',
            textNodeProperties: ["url", "title", "summary", "keywords"]
        })
        t2 = performance.now();

        const results = [];

        results.push(...(await neo4jVectorIndex.similaritySearchWithScore(query, 10)).map(doc => {
            return convertDocPageContentToJSON(doc[0].pageContent, doc[1])
        }))

        // Stage 2
        t3 = performance.now();
        let keywords = await extract_keywords(query);
        if (keywords.length > 0) {
            let records = await keywordBasedSearch(keywords);
            response["keywords"] = keywords
            response["keyword_search"] = records
        }
        t4 = performance.now();
        
        response["semantic_keyword_search"] = results
        response["performance"] = {
            "semantic_keyword_search": t2-t1,
            "keyword_search": t4-t3
        }
        return response
    } catch (err) {
        throw err;
    }
}

export {
    driver,
    insertNodes,
    getSearchResults
}