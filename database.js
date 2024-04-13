var neo4j = require('neo4j-driver');
require("dotenv").config()

const URI = process.env.NEO4J_URI
const USERNAME = process.env.NEO4J_USERNAME
const PASSWORD = process.env.NEO4J_PASSWORD
const driver = neo4j.driver(URI, neo4j.auth.basic(USERNAME, PASSWORD));
const session = driver.session()

const CYPHER_INSERT_QUERY =
    `
UNWIND $webpages AS webpage
CREATE (w:Webpage {
    url: webpage.url,
    status: webpage.status,
    title: webpage.title,
    is_404: webpage.is_404,
    keywords: webpage.keywords,
    embeddings: webpage.embeddings,
    summary: webpage.summary
})

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
MERGE (k:Keyword {keyword: keyword})
MERGE (w)-[:HAS_KEYWORD]->(k)
`;

const CYPHER_CREATE_VECTOR_INDEX_QUERY =
`
CREATE VECTOR INDEX webpage_embeddings
IF NOT EXISTS FOR (w: Webpage) ON (w.embeddings)
OPTIONS {indexConfig: {
    vector.dimensions: 768,
    vector.similarity_function: 'cosine'
}}

`

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

module.exports = {
    driver,
    insertNodes
}