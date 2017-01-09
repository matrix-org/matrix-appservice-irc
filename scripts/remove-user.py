#!/usr/bin/env python
from __future__ import print_function
import argparse
import sys
import yaml
import json
import urllib
import requests

def get_appservice_token(reg):
    with open(reg, "r") as f:
        reg_yaml = yaml.load(f)
        return reg_yaml["as_token"]

def get_rooms(hs_url, token, user_id):
    res = requests.get(hs_url + "/_matrix/client/r0/sync?access_token=" + token).json()
    room_ids = []
    for room_id in res["rooms"]["join"]:
        room = res["rooms"]["join"][room_id]
        for s in room["state"]["events"]:
            if s["type"] == "m.room.member" and s["state_key"] == user_id and s["content"]["membership"] == "join":
                room_ids.append(room_id)
    return room_ids

def kick(hs_url, token, room_id, user_id):
    res = requests.post(
        hs_url + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/kick?access_token=" + token,
        data = json.dumps({
            "user_id": user_id,
            "reason": "Kicked by script",
        }),
    )
    res.raise_for_status()

def main(registration, homeserver, user_id):
    print("Removing %s from all bridged rooms" % (user_id,))
    token = get_appservice_token(registration)
    if not token:
        raise Exception("Cannot read as_token from registration file")

    room_ids = get_rooms(homeserver, token, user_id)
    print("Removing user from %d rooms" % (len(room_ids),))
    for r in room_ids:
        print("    %s" % (r,))
        kick(homeserver, token, r, user_id)

if __name__ == "__main__":
    parser = argparse.ArgumentParser("Remove a Matrix user from all known bridged rooms.")
    parser.add_argument("-r", "--registration", help="The path to the AS registration file", required=True)
    parser.add_argument("-u", "--userid", help="The user ID to remove to eg '@matthew:matrix.org'", required=True)
    parser.add_argument("-s", "--homeserver", help="Base homeserver URL eg 'https://matrix.org'", required=True)
    args = parser.parse_args()
    if not args.userid or not args.registration or not args.homeserver:
        parser.print_help()
        sys.exit(1)
    main(registration=args.registration, user_id=args.userid, homeserver=args.homeserver)
