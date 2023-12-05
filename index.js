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
  timeout_ms: 10 * 1000, // optional HTTP request timeout to apply to all requests.
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
  console.log("-----------------------------------------------");
  console.log("checking incoming Mastodon direct messages ....");
  console.log("-----------------------------------------------");

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
          let responseToSender = `Successfully subscribed to\n\n${result.ucid} (${result.channelName})`;
          if (result.status !== 204) {
            responseToSender = `Unable to subscribe to ${messageParts[1]}.`;
            if (result.status === 99) {
              responseToSender += `\n\nThe Channel-ID-Service likely provided a fake ChannelID and I wasn't able to determine the correct one automatically.`;
            }
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
              // check if length>500 after adding next subscription, then split it up!
              let checkmessage =
                responseMessage + `${channel.ucid}\n${channel.channelName}\n\n`;
              if (checkmessage.length > 500) {
                mastodonInstance.post("statuses", {
                  status: `@${sender} ${responseMessage}`,
                  in_reply_to_id: origStatusId,
                  visibility: "direct",
                });
                responseMessage = "You are currently subscribed to\n\n";
              }
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
        case "instance":
          console.log(
            "INSTANCE config command received from",
            sender,
            "change to",
            messageParts[1]
          );
          if (messageParts[1]) {
            let resultat = await changeInstance(messageParts[1], sender);

            let finalMessage = "Successfully set instance to";
            if (resultat) finalMessage = "Failed setting instance to";

            mastodonInstance.post("statuses", {
              status: `@${sender} ${finalMessage} ${messageParts[1]}`,
              in_reply_to_id: origStatusId,
              visibility: "direct",
            });
          }
          console.log("Sent instance config response to", sender);
          break;
        default:
          console.log("UNKNOWN COMMAND received from", sender);
      }

      // set unread to false
      let id = conversations.data[0].id;
      mastodonInstance.post(`conversations/${id}/read`);
    }
  }
  console.log("-------DONE-------");
}

async function getFeed() {
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  console.log("Grabbing feed from Invidious ....");
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

  //let currentTimestampInSec = Math.floor(Date.now() / 1000);

  let response = await fetch(
    `https://${invidiousInstance}/${invidiousFeedEndpoint}?max_results=1000`,
    {
      headers: {
        Authorization: `Bearer ${invidiousToken}`,
      },
    }
  );
  let responseData = await response.json();
  console.log(responseData.notifications.length, "Notifications found in feed");
  console.log(responseData.videos.length, "Videos found in feed");

  let allVideos = [...responseData.notifications, ...responseData.videos];

  // sort notifications together with videos descending from published time
  allVideos.sort((a, b) => {
    if (a.published > b.published) return -1;
    if (a.published < b.published) return 1;
    return 0;
  });

  let metadata = await Metadata.findOne({});
  //let lastchecked = currentTimestampInSec;
  let lastchecked = allVideos[0].published;
  if (metadata && metadata.lastchecked) {
    lastchecked = metadata.lastchecked;
  }

  for (let video of allVideos) {
    if (video.published > lastchecked) {
      // found video published since last checked
      // report video to all users subscribed to the channel

      let subscription = await Subscription.findOne({ ucid: video.authorId });

      for (let subscribedUsername of subscription.subscribedUsernames) {
        // new: get user information (instance setting)
        let subscribedUser = await User.findOne({
          username: subscribedUsername,
        });

        let instance = invidiousInstance;

        switch (subscribedUser.instance) {
          case "redirect":
            instance = "redirect.invidious.io";
            break;
          case "random":
            let apiResponse = await fetch(
              "https://api.invidious.io/instances.json?sort_by=type,health"
            );
            let apiJson = await apiResponse.json();
            let rndIdx = Math.floor(Math.random() * 20);
            instance = apiJson[rndIdx][0];
            break;
          default:
            instance = invidiousInstance;
        }

        mastodonInstance.post("statuses", {
          status: `@${subscribedUsername}\n\nOne of your subscriptions posted a new video\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${instance}/watch?v=${video.videoId}`,
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
  metadata.lastchecked = allVideos[0].published;
  await metadata.save();
}

async function addSubscription(channel, username) {
  console.log("Adding subscription to", channel);

  // Find out if channel is CHANNELID (starting with UC) or CHANNELNAME. If CHANNELNAME starts with @, remove it
  let ucid = channel;
  let channelName = "";
  if (!channel.startsWith("UC")) {
    // find ucid for channelname
    console.log("Finding ucid for channel name", channel);

    if (channel.startsWith("@")) channel = channel.substring(1);

    let youtubeResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id,snippet&maxResults=1&type=channel&q=${channel}&key=${process.env.YOUTUBE_API_KEY}`
    );
    console.log(youtubeResponse.status, youtubeResponse.statusText);
    let youtubeData = await youtubeResponse.json();
    ucid = youtubeData.items[0].id.channelId;
    channelName = youtubeData.items[0].snippet.channelTitle;
    console.log("Found ucid:", ucid);
  }

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

      // if invRespData is empty, then a fake UCID was given (e.g. @adriansdigitalbasement != UC4AN7B71GLxDnmnQDzcd2vw)
      // get info from youtube
      if (!invRespData.length) {
        if (!channelName) {
          console.log(
            "Found potential fake UCID .... trying to fetch relevant information from youtube"
          );
          let fakecheckResponse = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=id,snippet&maxResults=1&type=channel&q=${ucid}&key=${process.env.YOUTUBE_API_KEY}`
          );
          let fakecheckData = await fakecheckResponse.json();
          let fakeTitle = fakecheckData.items[0].snippet.channelTitle;

          // is @ contained in channel title? Then filter the part after it
          let filtered = fakeTitle.match(/\@([^\s]*)/)[1];
          if (filtered) {
            fakecheckResponse = await fetch(
              `https://www.googleapis.com/youtube/v3/search?part=id,snippet&maxResults=1&type=channel&q=${filtered}&key=${process.env.YOUTUBE_API_KEY}`
            );
            fakecheckData = await fakecheckResponse.json();
            ucid = fakecheckData.items[0].id.channelId;
            channelName = fakecheckData.items[0].snippet.channelTitle;
            console.log("Found new ucid:", ucid);

            subscription = await Subscription.findOne({ ucid });
            if (!subscription) {
              subscription = new Subscription();
              subscription.ucid = ucid;
              subscription.channelName = channelName;
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
          } else {
            return {
              status: 99,
              channelName: "",
              ucid: ucid,
            };
          }
        }
      } else {
        channelName = invRespData[0].author;
        subscription = new Subscription();
        subscription.ucid = ucid;
        subscription.channelName = channelName;
        subscription.subscribedUsernames = [username];
        await subscription.save();
      }
    } else {
      channelName = subscription.channelName;
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
    channelName: channelName,
    ucid: ucid,
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

async function changeInstance(instance, username) {
  let user = await User.findOne({ username });

  if (!user) return 99;

  switch (instance) {
    case "redirect":
    case "random":
    case "fixed":
      user.instance = instance;

      await user.save();
      break;
    default:
      return 99;
  }

  return 0;
}
