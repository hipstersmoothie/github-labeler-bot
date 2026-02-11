import {
  getLabelerLabelDefinitions,
  setLabelerLabelDefinitions,
} from "@skyware/labeler/scripts";
import { DID, PORT, MAXLABELS, SIGNING_KEY } from "./constants.js";
import { LabelerServer } from "@skyware/labeler";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[${new Date().toISOString()}] [labeler] ${msg}`, ...args);

const server = new LabelerServer({
  did: DID,
  signingKey: SIGNING_KEY,
  dbPath: process.env.DB_PATH,
});

server.app.listen({ port: PORT, host: "::" }, (error, address) => {
  if (error) {
    log("Failed to start:", error);
  } else {
    log("Listening on", address);
  }
});

const credentials = {
  identifier: DID,
  password: process.env.LABELER_PASSWORD!,
};

interface Label {
  name: string;
  description: string;
}

interface LabelRow {
  val: string;
  neg: boolean | number;
}

const numbers = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function getIdentifier(name: string) {
  // GitHub allows [A-Za-z0-9_.-]+ but bsky only supports ^[a-z-]+$
  let identifier = name
    // Replace the / in org/repo
    .replace("/", "-")
    // Replace _ and . with -
    .replaceAll("_", "-")
    .replaceAll(".", "-")
    // Convert to lowercase
    .toLowerCase();

  // replace numbers with the corresponding string representation
  for (let i = 0; i < numbers.length; i++) {
    const number = numbers[i];

    if (number && identifier.includes(`${i}`)) {
      identifier = identifier.replaceAll(`${i}`, number);
    }
  }

  return identifier;
}

async function createLabel({ name, description }: Label) {
  const identifier = getIdentifier(name);
  const currentLabels = (await getLabelerLabelDefinitions(credentials)) || [];

  if (currentLabels.find((label) => label.identifier === identifier)) {
    log("Label already exists:", identifier);
    return;
  }

  await setLabelerLabelDefinitions(credentials, [
    ...currentLabels,
    {
      identifier,
      severity: "inform",
      blurs: "none",
      defaultSetting: "warn",
      adultOnly: false,
      locales: [{ lang: "en", description, name }],
    },
  ]);
  log("Created label definition:", identifier);
}

export const addUserLabel = async (did: string, label: Label) => {
  const identifier = getIdentifier(label.name);
  // Get the current labels for the did
  const result = await server.db.execute({
    sql: "SELECT * FROM labels WHERE uri = ?",
    args: [did],
  });
  const rows = result.rows as unknown as LabelRow[];

  await createLabel(label);

  // make a set of the current labels
  const labels = rows.reduce((set, label) => {
    if (!label.neg) set.add(label.val);
    else set.delete(label.val);
    return set;
  }, new Set<string>());

  try {
    if (labels.size < MAXLABELS) {
      await server.createLabel({ uri: did, val: identifier });
      log("Labeled", did, "->", identifier, `(${labels.size + 1}/${MAXLABELS})`);
      return true;
    }
    log("Label limit reached for", did, "- current labels:", labels.size);
  } catch (err) {
    log("Failed to add label:", err);
  }

  return false;
};

export const clearUserLabels = async (did: string) => {
  // Get the current labels for the did
  const result = await server.db.execute({
    sql: "SELECT * FROM labels WHERE uri = ?",
    args: [did],
  });
  const rows = result.rows as unknown as LabelRow[];

  // make a set of the current labels
  const labels = rows.reduce((set, label) => {
    if (!label.neg) set.add(label.val);
    else set.delete(label.val);
    return set;
  }, new Set<string>());

  try {
    await server.createLabels({ uri: did }, { negate: [...labels] });
    log("Cleared", labels.size, "labels for", did);
  } catch (err) {
    log("Failed to clear labels:", err);
  }
};

interface Session {
  accessJwt: string;
  refreshJwt: string;
}

export const getStoredSession = async (): Promise<Session | null> => {
  // initialize session table if it doesn't exist
  await server.db.execute(
    `CREATE TABLE IF NOT EXISTS session (uri TEXT PRIMARY KEY, accessJwt TEXT, refreshJwt TEXT)`
  );

  // TODO: https://github.com/skyware-js/bot/issues/16
  return null;
  // return server.db
  //   .prepare<string[]>(`SELECT * FROM session WHERE uri = ?`)
  //   .get(DID) as unknown as Session | null;
};

export const setStoredSession = async (session: Session) => {
  await server.db.execute({
    sql: `INSERT OR REPLACE INTO session (uri, accessJwt, refreshJwt) VALUES (?, ?, ?)`,
    args: [DID, session.accessJwt, session.refreshJwt],
  });
};
