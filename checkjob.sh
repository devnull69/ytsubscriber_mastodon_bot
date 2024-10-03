#!/bin/bash
ps -ef | grep [i]ndex >/dev/null
if [ $? -ne 0 ]; then
   cd /home/devnull69/Projects/ytsubscriber_mastodon_bot
   node ./index.js 1>>./output.log 2>>./error.log &
fi

