import {
  Bot,
  ChatMessage,
  Conversation,
  DeletedChatMessage,
  IncomingChatPreference,
  Labeler,
} from "@skyware/bot";
import dedent from "dedent";
import { to } from "await-to-js";
import { octokit } from "./octokit.js";
import {
  addUserLabel,
  clearUserLabels,
  getStoredSession,
  setStoredSession,
} from "./label-server.js";
import { DID, HANDLE } from "./constants.js";

const SUCCESS_MESSAGE = "Success! We've verified your GitHub account.";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);

const bot = new Bot({
  emitChatEvents: true,
});

let session = await getStoredSession();

if (session) {
  try {
    await bot.resumeSession({
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      active: true,
      did: DID as `did:${string}:${string}`,
      handle: HANDLE,
    });
    log("Session resumed for", HANDLE);
  } catch (err) {
    log("Failed to resume session, will login fresh:", err);
    session = null;
  }
}

if (!session) {
  log("Logging in as", HANDLE);
  const session = await bot.login({
    identifier: process.env.DID!,
    password: process.env.LABELER_PASSWORD!,
  });

  await setStoredSession(session);
  log("Logged in successfully");
}

await bot.setChatPreference(IncomingChatPreference.All);
log("Bot ready, chat events enabled");

bot.on("error", (err) => {
  console.error(`[${new Date().toISOString()}] Bot error (may be transient):`, err);
});

bot.on("like", async ({ subject, user }) => {
  // We only care if the user liked the labeler
  if (subject instanceof Labeler !== true) {
    return;
  }

  log("Labeler liked by", user.did);

  const [err, conversation] = await to(
    bot.getConversationForMembers([user.did])
  );

  if (err) {
    log("Error getting conversation for like:", err);
    return;
  }

  await conversation.sendMessage({
    text: dedent`
      Hello! Let's onboard you to the GitHub labeler bot!

      This bot lets you add labels for repos you are a contributor to. You can add up to 4.

      First let's verify your GitHub account. For this to work you must list your Bluesky handle in your GitHub profile.

      Send your GitHub username in this format:

      github: your-username
    `,
  });
});

async function verifyUser(message: ChatMessage, conversation: Conversation) {
  const username = (message.text.split(":")[1] || "").trim();
  log("Verifying GitHub user:", username, "from", message.senderDid);

  if (!username) {
    await conversation.sendMessage({
      text: dedent`
        You must provide a GitHub username.
      `,
    });
    return;
  }

  const [socialErr, socials] = await to(
    octokit.users.listSocialAccountsForUser({ username })
  );

  if (socialErr) {
    log("GitHub API error fetching socials for", username, socialErr);
    await conversation.sendMessage({
      text: dedent`
        Something went wrong getting your social accounts. Please try again.
      `,
    });
    return;
  }

  const listedBlueskyHandle = socials.data.find(
    (account) => account.provider === "bluesky"
  );

  if (!listedBlueskyHandle) {
    log("User", username, "has no Bluesky in GitHub profile");
    await conversation.sendMessage({
      text: dedent`
        You must list your Bluesky handle in your GitHub profile.

        When you edit your profile, make sure to use the special Bluesky field!
      `,
    });
    return;
  }

  const [profileErr, profile] = await to(
    bot.getProfile(
      listedBlueskyHandle.url.replace("https://bsky.app/profile/", "")
    )
  );

  if (profileErr) {
    log("Could not fetch Bluesky profile for", username, profileErr);
    await conversation.sendMessage({
      text: dedent`
        Couldn't find your Bluesky profile.
      `,
    });
    return;
  }

  if (profile.did !== message.senderDid) {
    log("DID mismatch:", profile.did, "!=", message.senderDid);
    await conversation.sendMessage({
      text: dedent`
        The account your sending the message from is not the same as the account you listed in your GitHub profile.
      `,
    });
    return;
  }

  log("Verified", username, "->", profile.did);
  await conversation.sendMessage({
    text: dedent`
      ${SUCCESS_MESSAGE}

      To link github repo send a message like the following. We will confirm you are a collaborator on the repo.

      repo: your-username/your-repo

      > Note: Only public repos are supported for now.
    `,
  });
}

async function findGithubUsername(conversation: Conversation) {
  let cursor: string | undefined | null = null;
  let messages: Array<ChatMessage | DeletedChatMessage> = [];
  let confirmMessageIndex = -1;

  while (confirmMessageIndex === -1 && cursor !== undefined) {
    ({ messages, cursor } = await conversation.getMessages(
      cursor || undefined
    ));

    confirmMessageIndex = messages.findIndex(
      (message) =>
        message instanceof ChatMessage &&
        message.text.startsWith(SUCCESS_MESSAGE)
    );
  }

  if (confirmMessageIndex !== -1) {
    let previousMessage = messages[confirmMessageIndex + 1];

    // If the success message is the last message, we need to fetch more
    if (!previousMessage) {
      ({ messages, cursor } = await conversation.getMessages(
        cursor || undefined
      ));
      previousMessage = messages[0];
    }

    if (!previousMessage || !(previousMessage instanceof ChatMessage)) {
      await conversation.sendMessage({
        text: dedent`
          Something went wrong. Please try again.
        `,
      });
      return;
    }

    return (previousMessage.text.split(":")[1] || "").trim();
  }
}

async function addRepoLabelForUser(
  message: ChatMessage,
  conversation: Conversation
) {
  const githubUsername = await findGithubUsername(conversation);
  log("Adding repo label for", message.senderDid, "github:", githubUsername);

  if (!githubUsername) {
    await conversation.sendMessage({
      text: "Could not find your GitHub username. Please try again.",
    });
    return;
  }

  const input = (message.text.split(":")[1] || "").trim();
  const [org, repo] = input.split("/");

  if (!org) {
    await conversation.sendMessage({
      text: "Could not find the org name in the provided slug. Please try again.",
    });
    return;
  }

  if (!repo) {
    await conversation.sendMessage({
      text: "Could not find the repo name in the provided slug. Please try again.",
    });
    return;
  }

  const [searchErr, mergedPrs] = await to(
    octokit.search.issuesAndPullRequests({
      q: `repo:${input} author:${githubUsername} is:merged`,
    })
  );

  if (searchErr) {
    log("GitHub search error for", input, searchErr);
    await conversation.sendMessage({
      text: dedent`
        Something went wrong searching GitHub for merged PRs. Please try again.
      `,
    });
    return;
  }

  if (mergedPrs.data.items.length === 0) {
    try {
      // As a last ditch effort, check if the user is a contributor to the repo via the public API
      // We don't use the public API otherwise because there is no filtering.
      const res = await fetch(
        `https://api.github.com/repos/${input}/contributors?per_page=100`,
        {
          headers: {
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
          },
        }
      );
      const contributorList: { login: string }[] = await res.json();
      const isTopContributor = contributorList.some(
        (c) => c.login === githubUsername
      );

      if (!isTopContributor) {
        throw new Error("You aren't a contributor to the repo");
      }
    } catch (err) {
      log("Contributor check failed for", githubUsername, "on", input, err);
      await conversation.sendMessage({
        text: dedent`
          You have not merged any PRs to the repo so we cannot add the label.
        `,
      });
      return;
    }
  }

  const [repoErr, targetRepo] = await to(
    octokit.repos.get({
      owner: org,
      repo,
    })
  );

  if (repoErr) {
    log("GitHub repo fetch error for", input, repoErr);
    await conversation.sendMessage({
      text: dedent`
          Something went wrong. ${repoErr.message}
        `,
    });
    return;
  }

  const didAdd = await addUserLabel(message.senderDid, {
    name: input,
    description: dedent`
        ${targetRepo?.data.description || ""}
        ${targetRepo.data.html_url}
      `,
  });

  if (didAdd) {
    log("Added label", input, "for", message.senderDid);
    const ownership = org === githubUsername ? "You own" : "You contributed to";
    await conversation.sendMessage({
      text: dedent`
        Success! ${ownership} ${input}. And qualified for the label.
        
        > Note: It can take a few minutes for the label to be appear.
      `,
    });
  } else {
    log("Label limit reached for", message.senderDid, "- already has 4 labels");
    await conversation.sendMessage({
      text: dedent`
        You're at the limit of 4 labels! Please /reset if you want to add more.

        > Note: Really only 2 labels looks aesthetically pleasing, don't flex too hard.
      `,
    });
  }
}

bot.on("message", async (message: ChatMessage) => {
  log("Message from", message.senderDid, ":", message.text);

  const [err, conversation] = await to(
    bot.getConversationForMembers([message.senderDid])
  );

  if (err) {
    log("Error getting conversation:", err);
    return;
  }

  if (message.text.match(/^github:/i)) {
    await verifyUser(message, conversation);
  } else if (message.text.match(/^repo:/i)) {
    await addRepoLabelForUser(message, conversation);
  } else if (message.text.trim().match(/^\/reset$/i)) {
    log("Resetting labels for", message.senderDid);
    await clearUserLabels(message.senderDid);
    await conversation.sendMessage({
      text: "All labels have been cleared! It may take a few minutes for the changes to be reflected.",
    });
  } else {
    await conversation.sendMessage(
      {
        text: dedent`
          These are the commands you can use:

          - "github: your-username" to verify your GitHub account
          - "repo: your-username/your-repo" to add a label to your repo
          - "/reset" to clear all labels
          - "/help" to see these commands

          If you want to see the source code or fix a bug check out the repo: https://github.com/hipstersmoothie/github-labeler-bot
        `,
      },
      { resolveFacets: false }
    );
  }
});
