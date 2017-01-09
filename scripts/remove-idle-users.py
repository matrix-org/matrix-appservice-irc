#!/usr/bin/env python
from __future__ import print_function
import argparse
import sys
import json
import urllib
import requests

def get_room_id(homeserver, alias, token):
    res = requests.get(homeserver + "/_matrix/client/r0/directory/room/" + urllib.quote(alias) + "?access_token=" + token)
    res.raise_for_status()
    return res.json()["room_id"]

def get_last_active_ago(homeserver, user_id, token):
    res = requests.get(homeserver + "/_matrix/client/r0/presence/" + urllib.quote(user_id) + "/status?access_token=" + token).json()
    return res.get("last_active_ago", None)

def is_idle(homeserver, user_id, token, activity_threshold_ms):
    return get_last_active_ago(homeserver, user_id, token) > activity_threshold_ms

def get_idle_users(homeserver, room_id, token, since):
    res = requests.get(homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/joined_members?access_token=" + token)
    user_ids = [user_id for user_id in res.json().get("joined", None)]

    activity_threshold_ms = since * 24 * 60 * 60 * 1000

    return [user_id for user_id in user_ids if is_idle(homeserver, user_id, token, activity_threshold_ms)]

def kick_idlers(homeserver, homeserver_domain, room_id, token, since, user_prefix):
    reason = "Being idle for >%s days" % since

    user_ids = get_idle_users(homeserver, room_id, token, since)
    failure_responses = []
    count = 0
    print("There are %s idle users in %s" % (len(user_ids), room_id))
    for user_id in user_ids:
        # Ignore users that do not start with the user_prefix
        if not user_id.startswith(user_prefix):
            continue
        res = requests.post(
            homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/kick?access_token=" + token,
            data = json.dumps({
                "reason": reason,
                "user_id": user_id
            })
        )
        if res.status_code >= 400:
            failure_responses.append({ "user_id": user_id, "response_json": res.json()})
        else:
            count += 1
    print("Kicked %s users in total" % count)

    if len(failure_responses) == 0:
        return
    print("Could not kick the following users:")
    for failure in failure_responses:
        print("%s : %s - %s" % (failure["user_id"], failure["response_json"]["error"], failure["response_json"]["errcode"]))

def main(token, alias, homeserver, homeserver_domain, since, user_prefix):
    print("Removing idle users in %s" % alias)
    room_id = get_room_id(homeserver, alias, token)
    if not room_id:
        raise Exception("Cannot resolve room alias to room_id")

    kick_idlers(homeserver, homeserver_domain, room_id, token, since, user_prefix)

if __name__ == "__main__":
    parser = argparse.ArgumentParser("Remove idle users from a given Matrix room")
    parser.add_argument("-t", "--token", help="The access token", required=True)
    parser.add_argument("-a", "--alias", help="The alias of the room eg '#freenode_#matrix-dev:matrix.org'", required=True)
    parser.add_argument("-u", "--homeserver", help="Base homeserver URL eg 'https://matrix.org'", required=True)
    parser.add_argument("-d", "--domain", help="Domain of the homserver eg 'matrix.org'", required=True)
    parser.add_argument("-s", "--since", type=int, help="Days since idle users have been offline for eg '30'", required=True)
    parser.add_argument("-p", "--prefix", help="User prefix to determine whether a user should be kicked. E.g. @freenode_", required=True)
    args = parser.parse_args()
    if not args.token or not args.alias or not args.homeserver:
        parser.print_help()
        sys.exit(1)
    main(token=args.token, alias=args.alias, homeserver=args.homeserver, homeserver_domain=args.domain, since=args.since, user_prefix=args.prefix)
