//const Masto = require("mastodon");
import { default as Mastodon } from "mastodon";
import { JSDOM } from "jsdom";
import mongoose from "mongoose";
import { User } from "./model/user.js";
import { Subscription } from "./model/subscription.js";
import { Metadata } from "./model/metadata.js";

import "dotenv/config";

const invidiousInstance = process.env.INVIDIOUS_INSTANCE;

const invidiousFeedEndpoint = "api/v1/auth/feed";
const invidiousSubscriptionsEndpoint = "api/v1/auth/subscriptions";
const invidiousChannelEndpoint = "api/v1/channels/search";
const invidiousToken = process.env.INVIDIOUS_TOKEN;

let mastodonInstance = new Mastodon({
  access_token: process.env.MASTODON_ACCESS_TOKEN,
  timeout_ms: 60 * 1000, // optional HTTP request timeout to apply to all requests.
  api_url: `https://${process.env.MASTODON_BOT_INSTANCE}/api/v1/`, // optional, defaults to https://mastodon.social/api/v1/
});

const mongoDBConnect = process.env.MONGODB_CONNECT;
mongoose.connect(mongoDBConnect);

mongoose.connection.on("connected", async () => {
  console.log("DB connection active (" + mongoDBConnect + ")");
  await getFeed();
  setInterval(getFeed, 30 * 60 * 1000);

  await getNewConversations();
  setInterval(getNewConversations, 60 * 1000);
});

mongoose.connection.on("error", (err) => {
  console.log("DB connection failed: " + err);
});

async function getNewConversations() {
  console.log("-----------------------------------------");
  console.log("checking incoming messages ....");
  console.log("-----------------------------------------");

  let conversations = await mastodonInstance.get("conversations");

  for (let conv of conversations.data) {
    if (conv.unread) {
      let dom = JSDOM.fragment(conv.last_status.content);

      let contentParts = dom.textContent.split(" ");
      contentParts.shift();
      let messageText = contentParts.join(" ");

      let sender = conv.last_status.account.acct;
      console.log(sender, ":", messageText);

      let messageParts = messageText.split(" ");
      let command = messageParts[0];
      let origStatusId = conv.last_status.id;
      switch (command) {
        case "ping":
          console.log("PING received from", sender);
          mastodonInstance.post("statuses", {
            status: `@${sender} pong`,
            in_reply_to_id: origStatusId,
            visibility: "direct",
          });
          console.log("Sent pack PONG to", sender);
          break;
        case "subscribe":
          console.log(
            "SUBSCRIBE received from",
            sender,
            "subscribe to",
            messageParts[1]
          );
          let result = await addSubscription(messageParts[1], sender);
          console.log(result.status);
          let responseToSender = `Successfully subscribed to\n\n${messageParts[1]} (${result.channelName})`;
          if (result.status !== 204) {
            responseToSender = `Unable to subscribe to ${messageParts[1]}.\n\nYou must provide a valid channelId in order to subscribe.\n\nIf you only have the channel name, you can use the service on https://commentpicker.com/youtube-channel-id.php to find the channel ID.`;
          }
          mastodonInstance.post("statuses", {
            status: `@${sender} ${responseToSender}`,
            in_reply_to_id: origStatusId,
            visibility: "direct",
          });
          console.log("Sent subscription response to", sender);
          break;
        case "unsubscribe":
          console.log(
            "UNSUBSCRIBE received from",
            sender,
            "unsubscribe from",
            messageParts[1]
          );
          let result2 = await removeSubscription(messageParts[1], sender);
          console.log("removeSubscription result:", result2);
          let responseToSender2 = `Successfully unsubscribed from\n\n${messageParts[1]}`;
          if (result2 !== 0) {
            responseToSender2 = `Error unsubscribing from ${messageParts[1]}: ${result2}`;
          }
          mastodonInstance.post("statuses", {
            status: `@${sender} ${responseToSender2}`,
            in_reply_to_id: origStatusId,
            visibility: "direct",
          });
          console.log("Sent unsubscription response to", sender);
          break;
        case "list":
          console.log("LIST received from", sender);
          let currentSubscriptions = await User.findOne({ username: sender })
            .populate("subscribedTo")
            .exec();
          let responseMessage =
            "You are currently not subscribed to any channel.";
          if (
            currentSubscriptions &&
            currentSubscriptions.subscribedTo.length
          ) {
            responseMessage = "You are currently subscribed to\n\n";
            for (let channel of currentSubscriptions.subscribedTo) {
              responseMessage += `${channel.ucid}\n${channel.channelName}\n\n`;
            }
          }
          mastodonInstance.post("statuses", {
            status: `@${sender} ${responseMessage}`,
            in_reply_to_id: origStatusId,
            visibility: "direct",
          });
          console.log("Sent subscription list to", sender);
          break;
        default:
          console.log("UNKNOWN COMMAND received from", sender);
      }

      // set unread to false
      let id = conversations.data[0].id;
      mastodonInstance.post(`conversations/${id}/read`);
    }
  }
}

async function getFeed() {
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  console.log("Grabbing feed from invidious ....");
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

  let currentTimestampInSec = Math.floor(Date.now() / 1000);

  let response = await fetch(
    `https://${invidiousInstance}/${invidiousFeedEndpoint}`,
    {
      headers: {
        Authorization: `Bearer ${invidiousToken}`,
      },
    }
  );
  let responseData = await response.json();
  console.log(responseData.videos.length, "Videos found in feed");

  let metadata = await Metadata.findOne({});
  let lastchecked = currentTimestampInSec;
  if (metadata && metadata.lastchecked) {
    lastchecked = metadata.lastchecked;
  }

  for (let video of responseData.videos) {
    if (video.published >= lastchecked) {
      // found video published since last checked
      // report video to all users subscribed to the channel

      let subscription = await Subscription.findOne({ ucid: video.authorId });

      for (let subscribedUsername of subscription.subscribedUsernames) {
        mastodonInstance.post("statuses", {
          status: `@${subscribedUsername}\n\nOne of your subscriptions posted a new video\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${invidiousInstance}/watch?v=${video.videoId}`,
          visibility: "direct",
        });
        console.log("Sent new video message to", subscribedUsername);
      }
    }
  }

  // set last checked back to database
  if (!metadata) {
    metadata = new Metadata();
    console.log("METADATA created!");
  }
  metadata.lastchecked = currentTimestampInSec;
  await metadata.save();
}

async function addSubscription(ucid, username) {
  console.log("Adding subscription to", ucid);

  let response = await fetch(
    `https://${invidiousInstance}/${invidiousSubscriptionsEndpoint}/${ucid}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${invidiousToken}`,
      },
    }
  );
  let invRespData;
  if (response.status === 204) {
    // add subscription (if not exist) and add user to subscription
    let subscription = await Subscription.findOne({ ucid });
    // get Channel Name from Invidious
    let invResp = await fetch(
      `https://${invidiousInstance}/${invidiousChannelEndpoint}/${ucid}?q=*`
    );
    invRespData = await invResp.json();
    if (!subscription) {
      // console.log(invRespData);

      subscription = new Subscription();
      subscription.ucid = ucid;
      subscription.channelName = invRespData[0].author;
      subscription.subscribedUsernames = [username];
      await subscription.save();
    } else {
      if (!subscription.subscribedUsernames.includes(username)) {
        subscription.subscribedUsernames = [
          ...subscription.subscribedUsernames,
          username,
        ];
        await subscription.save();
      }
    }
    let subobjid = subscription._id;
    // add user (if not exist) and add subscription to the user
    let user = await User.findOne({ username });
    if (!user) {
      user = new User();
      user.username = username;
      user.subscribedTo = [subobjid];
      await user.save();
    } else {
      if (!user.subscribedTo.includes(subobjid)) {
        user.subscribedTo = [...user.subscribedTo, subobjid];
        await user.save();
      }
    }
  }

  return {
    status: response.status,
    channelName: invRespData ? invRespData[0].author : undefined,
  };
}

async function removeSubscription(ucid, username) {
  // remove subscription from user
  // if it was the last subscription, remove the user
  let subobj = await Subscription.findOne({ ucid });
  let user = await User.findOne({ username });

  let result = 0;
  if (user) {
    let subscriptions = user.subscribedTo;
    let idx = subscriptions.indexOf(subobj._id);
    if (idx !== -1) {
      subscriptions.splice(idx, 1);
      if (subscriptions.length) {
        // write back subscriptions
        user.subscribedTo = subscriptions;
        await user.save();
      } else {
        // remove user
        await User.deleteOne({ username });
      }
    } else {
      result = 98; // wasn't subscribed
    }
  } else {
    result = 99; // not a user
  }

  // remove user from subscription
  // if it was the last user, remove subscription and unsubscribe on invidious

  if (subobj) {
    let users = subobj.subscribedUsernames;
    let idx = users.indexOf(username);
    if (idx !== -1) {
      users.splice(idx, 1);
      if (users.length) {
        // write back users
        subobj.subscribedUsernames = users;
        await subobj.save();
      } else {
        // remove subscription
        await Subscription.deleteOne({ ucid });
        console.log("Removing invidious subscription to", ucid);

        let response = await fetch(
          `https://${invidiousInstance}/${invidiousSubscriptionsEndpoint}/${ucid}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${invidiousToken}`,
            },
          }
        );
        if (response.status !== 204) {
          result = 88; // technical problem unsubscribing from invidious
        }
      }
    } else {
      result = 98; // wasn't subscribed
    }
  } else {
    result = 97; // subscription doesn't exist
  }

  return result;
}