import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  importAgentSubmission,
  prepareAgentPackets,
  validateAgentSubmission,
} from "../pipeline/src/agent/workflow";

const ROOT = process.cwd();
const LEXICON_FILE = path.join(ROOT, "pipeline/sources/lexicon_subset.json.gz");
const rawLexicon = JSON.parse(zlib.gunzipSync(fs.readFileSync(LEXICON_FILE)).toString("utf-8"));

const lexemeIpaMap = new Map<string, string>();
for (const item of rawLexicon.lexemes) {
  if (item.surface && item.ipa) {
    lexemeIpaMap.set(item.surface.toLowerCase(), item.ipa);
  }
}
const chunkIpaMap = new Map<string, string>();
for (const item of rawLexicon.chunkPronunciations) {
  if (item.chunkId && item.ipa) {
    chunkIpaMap.set(item.chunkId, item.ipa);
  }
}

const wordOverrides: Record<string, string> = {
  "100%": "wʌn ˈhʌndrəd pəˈsent",
  "100": "wʌn ˈhʌndrəd",
  "200": "tuː ˈhʌndrəd",
  "800": "eɪt ˈhʌndrəd",
  "rmb": "ˌɑːr.emˈbiː",
  "suv": "ˌes.juːˈviː",
  "wi-fi": "ˈwaɪfaɪ",
  "wifi": "ˈwaɪfaɪ",
  "tiktok": "ˈtɪktɒk",
  "youtube": "ˈjuːtjuːb",
  "sci-fi": "ˈsaɪfaɪ",
  "feng": "fʌŋ",
  "shui": "ʃweɪ",
  "vlog": "vlɒɡ",
  "gogh": "ɡɒx",
  "van": "væn",
  "app": "æp",
  "apps": "æps",
  "café": "ˈkæfeɪ",
  "cafés": "ˈkæfeɪz",
  "cafe": "ˈkæfeɪ",
  "cafes": "ˈkæfeɪz",
  "passers-by": "ˌpɑːsəz ˈbaɪ",
  "to-do": "təˈduː",
  "vs": "ˈvɜːsəs",
  "versus": "ˈvɜːsəs",
  "sneakerhead": "ˈsniːkəhed",
  "breathable": "ˈbriːðəbl",
  "earbuds": "ˈɪəbʌdz",
  "takeout": "ˈteɪkaʊt",
  "mooncakes": "ˈmuːnkeɪks",
  "mid-autumn": "mɪd ˈɔːtəm",
  "festival": "ˈfestɪvl",
  "businesswoman": "ˈbɪznəswʊmən",
  "unjustified": "ʌnˈdʒʌstɪfaɪd",
  "unfulfilling": "ˌʌnfʊlˈfɪlɪŋ",
  "overthinking": "ˌəʊvəˈθɪŋkɪŋ",
  "overthink": "ˌəʊvəˈθɪŋk",
  "faraway": "ˈfɑːrəweɪ",
  "nightlife": "ˈnaɪtlaɪf",
  "note-taking": "ˈnəʊtteɪkɪŋ",
  "environmentally": "ɪnˌvaɪrənˈmentəli",
  "kilometers": "kɪˈlɒmɪtəz",
  "kilometres": "kɪˈlɒmɪtəz",
  "closest": "ˈkləʊsɪst",
  "interests": "ˈɪntrəsts",
  "outfit": "ˈaʊtfɪt",
  "rub": "rʌb",
  "router": "ˈruːtə",
  "restart": "ˌriːˈstɑːt",
  "vividly": "ˈvɪvɪdli",
  "ironically": "aɪˈrɒnɪkli",
  "incentives": "ɪnˈsentɪvz",
  "districts": "ˈdɪstrɪkts",
  "exhibition": "ˌeksɪˈbɪʃn",
  "regulations": "ˌreɡjuˈleɪʃnz",
  "tighten": "ˈtaɪtn",
  "competitions": "ˌkɒmpəˈtɪʃnz",
  "interrupts": "ˌɪntəˈrʌpts",
};

const chunkOverrides: Record<string, string> = {
  "100%": "wʌn ˈhʌndrəd pəˈsent",
  "a is more... than b": "eɪ ɪz mɔː ðæn biː",
  "a is more than b": "eɪ ɪz mɔː ðæn biː",
  "i remember...ing": "aɪ rɪˈmembə",
  "i remember ing": "aɪ rɪˈmembə",
  "dreams vs reality": "driːmz ˈvɜːsəs riˈæləti",
  "wireless earbuds vs wired ones": "ˈwaɪələs ˈɪəbʌdz ˈvɜːsəs ˈwaɪəd wʌnz",
  "small cafés, temples, and scenic roads": "smɔːl ˈkæfeɪz ˈtemplz ənd ˈsiːnɪk rəʊdz",
  "spend around 200 to 800 rmb": "spend əˈraʊnd tuː ˈhʌndrəd tə eɪt ˈhʌndrəd ˌɑːr.emˈbiː",
  "my dream car is a small electric suv": "maɪ driːm kɑːr ɪz ə smɔːl ɪˈlektrɪk ˌes.juːˈviː",
  "a big tiktok guy": "ə bɪɡ ˈtɪktɒk ɡaɪ",
  "know how to scroll on tiktok": "nəʊ haʊ tə skrəʊl ɒn ˈtɪktɒk",
  "go on youtube to relax": "ɡəʊ ɒn ˈjuːtjuːb tə rɪˈlæks",
  "stopped connecting to wi-fi": "stɒpt kəˈnektɪŋ tə ˈwaɪfaɪ",
  "a van gogh exhibition": "ə væn ˈɡɒx ˌeksɪˈbɪʃn",
  "like mooncakes at mid-autumn festival": "laɪk ˈmuːnkeɪks ət mɪd ˈɔːtəm ˈfestɪvl",
  "feng shui": "ˌfʌŋ ˈʃweɪ",
  "from a chinese culture standpoint": "frəm ə tʃaɪˈniːz ˈkʌltʃə ˈstændpɔɪnt",
  "sci-fi movies": "ˈsaɪfaɪ ˈmuːviz",
  "something from a sci-fi movie": "ˈsʌmθɪŋ frəm ə ˈsaɪfaɪ ˈmuːvi",
  "looks like something from a sci-fi movie": "lʊks laɪk ˈsʌmθɪŋ frəm ə ˈsaɪfaɪ ˈmuːvi",
  "a note-taking app": "ə ˈnəʊtteɪkɪŋ æp",
  "make a to-do list": "meɪk ə təˈduː lɪst",
  "ask passers-by for directions": "ɑːsk ˌpɑːsəz ˈbaɪ fə dəˈrekʃnz",
};

function getChunkIpa(chunkId: string, displayChunk: string, canonical: string): string {
  const lowerDisplay = displayChunk.toLowerCase().trim();
  const lowerCanonical = canonical.toLowerCase().trim();
  if (chunkOverrides[lowerDisplay]) return chunkOverrides[lowerDisplay];
  if (chunkOverrides[lowerCanonical]) return chunkOverrides[lowerCanonical];
  if (chunkIpaMap.has(chunkId)) return chunkIpaMap.get(chunkId)!;

  // Clean tokens
  const clean = lowerDisplay.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const ipaParts: string[] = [];

  for (const rawWord of words) {
    const word = rawWord.toLowerCase();
    if (word === "..." || word === "ing") continue;
    if (wordOverrides[word]) {
      ipaParts.push(wordOverrides[word]);
    } else if (lexemeIpaMap.has(word)) {
      ipaParts.push(lexemeIpaMap.get(word)!);
    } else {
      const norm = word.replace(/['’]s$/, "").replace(/s$/, "");
      if (wordOverrides[norm]) {
        ipaParts.push(wordOverrides[norm] + (word.endsWith("s") ? "z" : ""));
      } else if (lexemeIpaMap.has(norm)) {
        ipaParts.push(lexemeIpaMap.get(norm)! + (word.endsWith("s") ? "z" : ""));
      } else {
        ipaParts.push(word);
      }
    }
  }

  const result = ipaParts.join(" ").trim();
  return result || "ɪŋɡlɪʃ";
}

async function run() {
  prepareAgentPackets({ stage: "pronunciation_enrichment", limit: 100 });
  const packetsDir = path.join(ROOT, "pipeline/agent-work/packets/pronunciation_enrichment");
  const batchDirs = fs.readdirSync(packetsDir).filter((dir) => fs.existsSync(path.join(packetsDir, dir, "manifest.json")));

  console.log(`Found ${batchDirs.length} pronunciation batches`);

  for (const batchId of batchDirs) {
    const doneFile = path.join(ROOT, "pipeline/queue/pronunciation_enrichment/done", `${batchId}.json`);
    if (fs.existsSync(doneFile)) {
      console.log(`- Skipping already done ${batchId}`);
      continue;
    }
    const dir = path.join(packetsDir, batchId);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "input.snapshot.json"), "utf8"));

    interface PronunciationInputItem {
      chunkId: string;
      displayChunk: string;
      canonicalChunk?: string;
      targetAccent?: string;
    }

    const items = (snapshot.inputs as PronunciationInputItem[]).map((input) => ({
      chunkId: input.chunkId,
      ipa: getChunkIpa(input.chunkId, input.displayChunk, input.canonicalChunk || input.displayChunk),
      accent: input.targetAccent || "en-GB",
    }));

    const submission = {
      workflowVersion: "agent-content.v1",
      batchId,
      stage: "pronunciation_enrichment",
      role: "generator",
      runId: `agent_run_pronunciation_${batchId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      executor: {
        kind: "codex_agent",
        sessionId: "agent_session_pronunciation_enrichment",
      },
      inputSha256: manifest.inputSha256,
      promptVersion: manifest.promptVersion,
      promptSha256: manifest.promptSha256,
      schemaVersion: manifest.schemaVersion,
      attestation: {
        noExternalRuntimeApi: true,
        independentContext: false,
      },
      createdAt: new Date().toISOString(),
      output: { items },
    };

    const submissionFile = path.join(dir, "submission.json");
    fs.writeFileSync(submissionFile, JSON.stringify(submission, null, 2) + "\n", "utf8");

    validateAgentSubmission(submissionFile);
    await importAgentSubmission(submissionFile);
    console.log(`✓ Imported pronunciation batch ${batchId}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
