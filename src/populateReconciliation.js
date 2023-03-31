import fs from "fs";
import path from "path";
import ttl2jsonld from "@frogcat/ttl2jsonld";
import elasticsearch from "@elastic/elasticsearch";
import esb from "elastic-builder";
import jsonld from "jsonld";
import { context } from "./context.js";

const esIndex = "skohub-reconcile";

const setupEsClient = () => {
  return new elasticsearch.Client({
    node: `http://localhost:9200`,
  });
};

const esClient = setupEsClient();

async function collectData(filePath, log) {
  var data = [];
  const account = path.basename(path.dirname(filePath));
  log.log.push(`> Read and parse ${account}/${path.basename(filePath)} ...`);
  console.log(`> Read and parse ${account}/${path.basename(filePath)} ...`);
  if (!/[a-zA-Z0-9]/.test(account.slice(0, 1))) {
    console.log(
      `> Invalid data: account must start with a letter or a number. Instead, its value is: ${account}`
    );
  }
  const ttlString = await fs.readFileSync(filePath).toString();
  const j = await buildJSON(ttlString.toString(), account);
  if (!/[a-zA-Z0-9]/.test(j.dataset.slice(0, 1))) {
    console.log(
      `> Invalid data: dataset must start with a letter or a number. Instead, its value is: ${j.dataset}`
    );
  }
  data.push({ account: j.account, dataset: j.dataset, entries: j.entries });
  return data;
}

async function buildJSON(ttlString, account) {
  const doc = ttl2jsonld.parse(ttlString);
  const expanded = await jsonld.expand(doc);
  const compacted = await jsonld.compact(expanded, context);
  // TODO get all available languages and stor them as attribute for Concept Scheme
  var entries = [];
  var dataset = "";

  compacted["@graph"].forEach((graph, _) => {
    const { ...properties } = graph;
    const type = Array.isArray(properties.type)
      ? properties.type.find((t) => ["Concept", "ConceptScheme"])
      : properties.type;
    const node = {
      ...properties,
      type,
    };
    if (node.type === "ConceptScheme") {
      dataset = node.id;
      if (typeof node.preferredNamespaceUri === "string") {
        const id = node.preferredNamespaceUri;
        node.preferredNamespaceUri = { id };
      }
    } else if (node.type === "Concept") {
      dataset = node?.inScheme?.[0]?.id ?? node.topConceptOf[0].id;
    }
    node["dataset"] = dataset;
    node["account"] = account;

    entries.push(node);
  });
  return { account: account, dataset: dataset, entries: entries };
}

async function deleteData(account, dataset) {
  const requestBody = esb
    .requestBodySearch()
    .query(
      esb
        .boolQuery()
        .must([
          ...(dataset && [esb.termQuery("dataset.keyword", dataset)]),
          ...(account && [esb.termQuery("account.keyword", account)]),
        ])
    );
  return esClient.deleteByQuery({
    index: esIndex,
    refresh: true,
    body: requestBody.toJSON(),
  });
}

async function sendData(entries) {
  const operations = entries.flatMap((doc) => [
    { index: { _index: "skohub-reconcile" } },
    doc,
  ]);
  const bulkResponse = await esClient.bulk({
    refresh: true,
    operations,
  });

  if (bulkResponse.errors) {
    const erroredDocuments = [];
    // The items array has the same order of the dataset we just indexed.
    // The presence of the `error` key indicates that the operation
    // that we did for the document has failed.
    bulkResponse.items.forEach((action, i) => {
      const operation = Object.keys(action)[0];
      if (action[operation].error) {
        erroredDocuments.push({
          // If the status is 429 it means that you can retry the document,
          // otherwise it's very likely a mapping error, and you should
          // fix the document before to try it again.
          status: action[operation].status,
          error: action[operation].error,
          operation: operations[i * 2],
          document: operations[i * 2 + 1],
        });
      }
    });
    console.log(erroredDocuments);
  }

  return bulkResponse;
}

function writeLog(log) {
  fs.writeFileSync(`public/log/${log.id}.json`, JSON.stringify(log));
}

async function process(filePath, log) {
  const data = await collectData(filePath, log);
  console.log("data there");
  for await (const v of data) {
    try {
      const response = await sendData(v.entries);
      if (response.errors) {
        console.log(
          `> Warning: SendData ${v.account}/${v.dataset} had failures. Better check response:\n`,
          response
        );
      } else {
        console.log(
          `> ${v.account}/${v.dataset}: Successfully sent ${response.items.length} documents to ES index.`
        );
        log.status = "success";
        writeLog(log);
      }
    } catch (error) {
      console.error(
        `Failed populating ${esIndex} index of ES server with account: ${v.account} and dataset: ${v.dataset}. Abort!`,
        error
      );
    }
  }
}

export default function (filePath, id) {
  const log = {
    id: id,
    status: "processing",
    log: [],
  };
  writeLog(log);
  console.log("collecting data");
  process(filePath, log);
  return 
}
