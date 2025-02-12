import { default as Mastodon } from "mastodon";
import { JSDOM } from "jsdom";
import mongoose from "mongoose";
import { User } from "./model/user.js";
import { Subscription } from "./model/subscription.js";
import { Metadata } from "./model/metadata.js";

import "dotenv/config";

const ANSI_BRIGHT = "\x1b[1m";
const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

let starttime = Date.now();

const invidiousInstance = process.env.INVIDIOUS_INSTANCE;

const invidiousFeedEndpoint = "api/v1/auth/feed";
const invidiousSubscriptionsEndpoint = "api/v1/auth/subscriptions";
const invidiousChannelEndpoint = "api/v1/channels/search";
const invidiousToken = process.env.INVIDIOUS_TOKEN;

let feedInterval = null;
let conversationInterval1 = null;
let conversationInterval2 = null;

let mastodonInstance = new Mastodon({
  access_token: process.env.MASTODON_ACCESS_TOKEN,
  timeout_ms: 3 * 1000, // optional HTTP request timeout to apply to all requests.
  api_url: `https://${process.env.MASTODON_BOT_INSTANCE}/api/v1/`, // optional, defaults to https://mastodon.social/api/v1/
});

let mastodonInstance2 = new Mastodon({
  // nrw.social backup
  access_token: process.env.MASTODON_ACCESS_TOKEN2,
  timeout_ms: 3 * 1000, // optional HTTP request timeout to apply to all requests.
  api_url: `https://${process.env.MASTODON_BOT_INSTANCE2}/api/v1/`, // optional, defaults to https://mastodon.social/api/v1/
});

const mongoDBConnect = process.env.MONGODB_CONNECT;
mongoose.connect(mongoDBConnect);

mongoose.connection.on("connected", async () => {
  console.log(
    ANSI_BRIGHT + "DB connection active (" + mongoDBConnect + ")" + ANSI_RESET
  );

  if (!feedInterval) await getFeed();

  if (!conversationInterval1)
    await getNewConversations(mastodonInstance, "social.cologne");
  if (!conversationInterval2)
    await getNewConversations(mastodonInstance2, "nrw.social");

  if (process.env.RUN_AS_JOB !== "true") {
    if (!feedInterval) feedInterval = setInterval(getFeed, 30 * 60 * 1000);
    if (!conversationInterval1)
      conversationInterval1 = setInterval(
        () => getNewConversations(mastodonInstance, "social.cologne"),
        60 * 1000
      );
    if (!conversationInterval2)
      conversationInterval2 = setInterval(
        () => getNewConversations(mastodonInstance2, "nrw.social"),
        62 * 1000
      );
  } else {
    await mongoose.disconnect();

    let totaltime = Date.now() - starttime;
    console.log("TIME:", totaltime, "ms");
  }
});

mongoose.connection.on("error", (err) => {
  console.log(ANSI_RED + "DB connection failed: " + err + ANSI_RESET);
});

async function getNewConversations(mastInstance, instName) {
  let starttime = Date.now();
  console.log(
    "-----------------------------------------------------------------------------------------------------"
  );
  console.log(
    new Date().toLocaleString() +
      ": checking incoming Mastodon direct messages .... " +
      instName
  );
  console.log(
    "-----------------------------------------------------------------------------------------------------"
  );

  try {
    let conversations = await mastInstance.get("conversations");

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
            mastInstance.post("statuses", {
              status: `@${sender} pong`,
              in_reply_to_id: origStatusId,
              visibility: "direct",
            });
            console.log(ANSI_BRIGHT + "Sent pack PONG to", sender, ANSI_RESET);
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
            mastInstance.post("statuses", {
              status: `@${sender} ${responseToSender}`,
              in_reply_to_id: origStatusId,
              visibility: "direct",
            });
            console.log(
              ANSI_BRIGHT + "Sent subscription response to",
              sender,
              ANSI_RESET
            );
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
            mastInstance.post("statuses", {
              status: `@${sender} ${responseToSender2}`,
              in_reply_to_id: origStatusId,
              visibility: "direct",
            });
            console.log(
              ANSI_BRIGHT + "Sent unsubscription response to",
              sender,
              ANSI_RESET
            );
            break;
          case "list":
            console.log("LIST received from", sender);
            let currentSubscriptions = await User.findOne({
              username: sender,
            })
              .populate("subscribedTo")
              .exec();
            let responseMessage =
              "You are currently not subscribed to any channel.";
            if (
              currentSubscriptions &&
              currentSubscriptions.subscribedTo.length
            ) {
              responseMessage = `Your instance setting is: ${currentSubscriptions.instance}\n\nYou are currently subscribed to\n\n`;
              for (let channel of currentSubscriptions.subscribedTo) {
                // check if length>500 after adding next subscription, then split it up!
                let checkmessage =
                  responseMessage +
                  `${channel.ucid}\n${channel.channelName}\n\n`;
                if (checkmessage.length > 490) {
                  mastInstance.post("statuses", {
                    status: `@${sender} ${responseMessage}`,
                    in_reply_to_id: origStatusId,
                    visibility: "direct",
                  });
                  responseMessage = "You are also subscribed to\n\n";
                }
                responseMessage += `${channel.ucid}\n${channel.channelName}\n\n`;
              }
            }
            mastInstance.post("statuses", {
              status: `@${sender} ${responseMessage}`,
              in_reply_to_id: origStatusId,
              visibility: "direct",
            });
            console.log(
              ANSI_BRIGHT + "Sent subscription list to",
              sender,
              ANSI_RESET
            );
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

              mastInstance.post("statuses", {
                status: `@${sender} ${finalMessage} ${messageParts[1]}`,
                in_reply_to_id: origStatusId,
                visibility: "direct",
              });
            }
            console.log(
              ANSI_BRIGHT + "Sent instance config response to",
              sender,
              ANSI_RESET
            );
            break;
          case "setfixedtoinstance":
            console.log(
              "SETFIXEDTOINSTANCE config command received from",
              sender,
              "change to",
              messageParts[1]
            );
            if (sender === "devnull69@ruhr.social") {
              // only authorized admin user!
              console.log(
                ANSI_BRIGHT,
                sender,
                "is authorized to perform this action!" + ANSI_RESET
              );
              let resultat = await changeFixedInstance(messageParts[1]);
              let finalMessage = "Successfully set fixed instance to";
              if (resultat) finalMessage = "Failed setting fixed instance to";

              mastInstance.post("statuses", {
                status: `@${sender} ${finalMessage} ${messageParts[1]}`,
                in_reply_to_id: origStatusId,
                visibility: "direct",
              });
            } else {
              console.log(
                ANSI_RED,
                sender,
                "is NOT authorized to perform this action!" + ANSI_RESET
              );
            }
            break;
          case "resend":
            let count = messageParts[1]
              ? Number(messageParts[1]) > 10
                ? 10
                : Number(messageParts[1])
              : 3;
            console.log(
              "RESEND config command received from",
              sender,
              "for number of messages #",
              count
            );
            let latest = await getVideosFromFeed(count * 3);

            let metadata = await Metadata.findOne({});

            await checkAndResendMessage(latest, metadata, sender, count);
            break;
          case "resendall":
            let countAll = messageParts[1]
              ? Number(messageParts[1]) > 10
                ? 10
                : Number(messageParts[1])
              : 3;
            console.log(
              "RESENDALL config command received from",
              sender,
              "for number of messages #",
              countAll
            );
            if (sender === "devnull69@ruhr.social") {
              // only authorized admin user!
              console.log(
                ANSI_BRIGHT,
                sender,
                "is authorized to perform this action!" + ANSI_RESET
              );
              let latest = await getVideosFromFeed(countAll + 3);

              let metadata = await Metadata.findOne({});

              await checkAndResendMessage(latest, metadata, "*", countAll);
            } else {
              console.log(
                ANSI_RED,
                sender,
                "is NOT authorized to perform this action!" + ANSI_RESET
              );
            }
            break;
          default:
            console.log(
              ANSI_RED + "UNKNOWN COMMAND received from",
              sender,
              ANSI_RESET
            );
        }

        // set unread to false
        let id = conversations.data[0].id;
        mastInstance.post(`conversations/${id}/read`);
      }
    }
  } catch (e) {
    console.log(
      ANSI_RED + "Timeout" + ANSI_RESET + "... waiting for next cycle"
    );
  }
  let totaltime = Date.now() - starttime;

  console.log("TIME:", totaltime, "ms");

  console.log(ANSI_GREEN + "-------DONE-------" + ANSI_RESET);
}

async function sendMessageToSubscribers(video, metadata) {
  // found video published since last checked
  // report video to all users subscribed to the channel

  console.log("Sending message to subscribers....", video.videoId);
  let subscription = await Subscription.findOne({
    ucid: video.authorId,
  });

  console.log("Subscriptions loaded, finding users....");
  if (!subscription) return;

  for (let subscribed of subscription.subscribedUsers) {
    let subscribedUsername = subscribed.username;
    // new: get user information (instance setting)
    let subscribedUser = await User.findOne({
      username: subscribedUsername,
    });

    console.log(
      "User info retrieved, determining instance....",
      subscribedUser.instance
    );
    let instance = invidiousInstance;

    switch (subscribedUser.instance) {
      case "redirect":
        instance = "redirect.invidious.io";
        break;
      case "random":
        // let apiResponse = await fetch(
        //   "https://api.invidious.io/instances.json?sort_by=type,health"
        // );
        // let apiJson = await apiResponse.json();
        // let rndIdx = Math.floor(Math.random() * apiJson.length);
        // instance = apiJson[rndIdx][0];
        instance = metadata.fixedInstance ?? invidiousInstance;
        break;
      case "fixed":
        instance = metadata.fixedInstance ?? invidiousInstance;
        break;
      default:
        instance = subscribedUser.instance; // instance is directly given for specific user
    }

    if (video.published >= subscribed.subscribedAt) {
      console.log(
        ANSI_BRIGHT + "Trying to send new video message to",
        subscribedUsername,
        ANSI_RESET
      );
      await mastodonInstance2.post("statuses", {
        status: `@${subscribedUsername}\n\nOne of your subscriptions posted a new video\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${instance}/watch?v=${video.videoId}`,
        visibility: "direct",
      });
      console.log(
        ANSI_BRIGHT + "Sent new video message to",
        subscribedUsername,
        ANSI_RESET
      );
      await delay(1000);
    }
  }
}

async function checkAndResendMessage(
  allVideos,
  metadata,
  username,
  resendCount
) {
  let totalResent = 0;
  let idx = 0;

  while (totalResent < resendCount && idx < allVideos.length) {
    let video = allVideos[idx];
    let subscription = await Subscription.findOne({
      ucid: video.authorId,
    });

    if (subscription) {
      if (username === "*") {
        // resend this video to all subscribed users
        for (let user of subscription.subscribedUsers) {
          let username = user.username;
          let subscribedUser = await User.findOne({
            username,
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
            case "fixed":
              instance = metadata.fixedInstance ?? invidiousInstance;
              break;
            default:
              instance = subscribedUser.instance;
          }
          mastodonInstance.post("statuses", {
            status: `@${username}\n\nOne of your subscriptions posted a new video\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${instance}/watch?v=${video.videoId}`,
            visibility: "direct",
          });
          console.log(
            ANSI_BRIGHT + "Sent new video message to",
            username,
            ANSI_RESET
          );
        }
        totalResent++;
      } else {
        // resend this video to selected user
        if (
          subscription.subscribedUsers.find(
            (user) => user.username === username
          )
        ) {
          let subscribedUser = await User.findOne({
            username,
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
            case "fixed":
              instance = metadata.fixedInstance ?? invidiousInstance;
              break;
            default:
              instance = subscribedUser.instance;
          }
          mastodonInstance.post("statuses", {
            status: `@${username}\n\nOne of your subscriptions posted a new video\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${instance}/watch?v=${video.videoId}`,
            visibility: "direct",
          });
          console.log(
            ANSI_BRIGHT + "Sent new video message to",
            username,
            ANSI_RESET
          );
          totalResent++;
        }
      }
    }
    idx++;
  }
}

async function getVideosFromFeed(count) {
  let response = await fetch(
    `https://${invidiousInstance}/${invidiousFeedEndpoint}?max_results=${count}`,
    {
      headers: {
        Authorization: `Bearer ${invidiousToken}`,
        "User-Agent": "PostmanRuntime/7.43.0",
      },
    }
  );
  let responseData = await response.json();
  console.log(responseData.notifications.length, "Notifications found in feed");
  console.log(responseData.videos.length, "Videos found in feed");

  let result = [...responseData.notifications, ...responseData.videos];

  // sort notifications together with videos descending from published time
  result.sort((a, b) => {
    if (a.published > b.published) return -1;
    if (a.published < b.published) return 1;
    return 0;
  });

  return result;
}

async function getFeed() {
  let starttime = Date.now();
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  console.log("Grabbing feed from Invidious ....");
  console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

  //let currentTimestampInSec = Math.floor(Date.now() / 1000);

  let allVideos = await getVideosFromFeed(1000);

  let metadata = await Metadata.findOne({});

  console.log("last checked video", allVideos[0].published);

  try {
    //let lastchecked = currentTimestampInSec;
    let lastchecked = allVideos[0].published;
    if (metadata && metadata.lastchecked) {
      lastchecked = metadata.lastchecked;
    }

    let lasttwenty = metadata.lasttwenty;

    for (let video of allVideos) {
      if (video.published > lastchecked) {
        await sendMessageToSubscribers(video, metadata);
        console.log("Pushing new video to lasttwenty....");
        lasttwenty.push(video.videoId);
      }
    }

    // check last twenty
    for (let i = 0; i < 10; i++) {
      // what
      let video = allVideos[i];
      if (!lasttwenty.includes(video.videoId)) {
        await sendMessageToSubscribers(video, metadata);
        // mastodonInstance.post("statuses", {
        //   status: `@devnull69@ruhr.social\n\nOut of order video detected, user was informed!\n\nChannel: ${video.author}\nTitle: ${video.title}\nVideo: https://${invidiousInstance}/watch?v=${video.videoId}`,
        //   visibility: "direct",
        // });
      }
    }

    // set last checked back to database
    if (!metadata) {
      metadata = new Metadata();
      console.log("METADATA created!");
    }
    metadata.lastchecked = allVideos[0].published;

    //update last twenty
    lasttwenty = [];
    console.log("Updating lasttwenty and saving....");
    for (let i = 0; i < 20; i++) {
      lasttwenty.push(allVideos[i].videoId);
    }
    metadata.lasttwenty = lasttwenty;
    await metadata.save();
  } catch (e) {
    console.log(
      ANSI_RED + "Error occurred, maybe instance is down" + ANSI_RESET
    );
  }
  let totaltime = Date.now() - starttime;

  console.log("TIME:", totaltime, "ms");
}

async function addSubscription(channel, username) {
  console.log(ANSI_BRIGHT + "Adding subscription to", channel, ANSI_RESET);

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
        "User-Agent": "PostmanRuntime/7.43.0",
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
              subscription.subscribedUsers = [
                {
                  username,
                  subscribedAt: Math.floor(Date.now() / 1000),
                },
              ];
              await subscription.save();
            } else {
              if (
                !subscription.subscribedUsers.find(
                  (user) => user.username === username
                )
              ) {
                subscription.subscribedUsers = [
                  ...subscription.subscribedUsers,
                  {
                    username,
                    subscribedAt: Math.floor(Date.now() / 1000),
                  },
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
        subscription.subscribedUsers = [
          {
            username,
            subscribedAt: Math.floor(Date.now() / 1000),
          },
        ];
        await subscription.save();
      }
    } else {
      channelName = subscription.channelName;
      if (
        !subscription.subscribedUsers.find((user) => user.username === username)
      ) {
        subscription.subscribedUsers = [
          ...subscription.subscribedUsers,
          {
            username,
            subscribedAt: Math.floor(Date.now() / 1000),
          },
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
    let newusers = subobj.subscribedUsers;
    let newidx = newusers.findIndex((user) => user.username === username);
    if (newidx !== -1) {
      newusers.splice(newidx, 1);
      if (newusers.length) {
        // write back users
        subobj.subscribedUsers = newusers;
        await subobj.save();
      } else {
        // remove subscription
        await Subscription.deleteOne({ ucid });
        console.log(
          ANSI_BRIGHT + "Removing invidious subscription to",
          ucid,
          ANSI_RESET
        );

        let response = await fetch(
          `https://${invidiousInstance}/${invidiousSubscriptionsEndpoint}/${ucid}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${invidiousToken}`,
              "User-Agent": "PostmanRuntime/7.43.0",
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

  user.instance = instance;

  await user.save();

  return 0;
}

async function delay(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve("DONE");
    }, ms);
  });
}

async function changeFixedInstance(instance) {
  let metadata = await Metadata.findOne({});

  if (!metadata) return 99;

  metadata.fixedInstance = instance;
  await metadata.save();

  return 0;
}
