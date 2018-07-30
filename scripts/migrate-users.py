#!/usr/bin/env python
from __future__ import print_function
import argparse
from datetime import datetime
import sys
import json
import yaml
import urllib
import requests
import time
import re

# import logging
# import httplib as http_client
# http_client.HTTPConnection.debuglevel = 1
# logging.basicConfig()
# logging.getLogger().setLevel(logging.DEBUG)
# requests_log = logging.getLogger("requests.packages.urllib3")
# requests_log.setLevel(logging.DEBUG)
# requests_log.propagate = True

# If you're running into M_NOT_JSON issues, python-requests strips the body of request on 301 redirects. Make sure you're using the direct url of your homeserver.
# See https://github.com/requests/requests/issues/2590

def get_appservice_token(reg):
    with open(reg, "r") as f:
        reg_yaml = yaml.load(f)
        return reg_yaml["as_token"]

def get_users(homeserver, room_id, token, user_prefix, name_suffix):
    res = requests.get(homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/joined_members?access_token=" + token)
    joined = res.json().get("joined", None)
    user_ids = [user_id for user_id in joined if user_id.startswith(user_prefix) and (joined.get(user_id).get("display_name") or "").endswith(name_suffix) ]
    return { uid: joined.get(uid).get("display_name") for uid in user_ids }

def get_rooms(homeserver, token):
    res = requests.get(homeserver + "/_matrix/client/r0/joined_rooms?access_token=" + token).json()
    room_ids = []
    for room_id in res["joined_rooms"]:
        room_ids.append(room_id)
    return room_ids

def migrate_displayname(uid, oldname, suffix, homeserver, token):
    newname = re.sub(re.escape(suffix)+'$', "", oldname).rstrip()
    print("Migrating %s from %s to %s" % (uid, oldname, newname))
    headers = { 'Content-Type': 'application/json' }
    res = requests.put(homeserver + "/_matrix/client/r0/profile/" + urllib.quote(uid) + "/displayname?access_token=" + token + "&user_id=" + urllib.quote(uid),
                       data = json.dumps({ 'displayname': newname }), headers=headers)
    if res.json():
        print(res.json())
        if 'M_NOT_JSON' in str(res.json()):
            print("python-requests strips the body of the request on 301 redirects (https://github.com/requests/requests/issues/2590). Make sure you're using the direct url of your homeserver.")

def main(registration, homeserver, prefix, suffix):
    token = get_appservice_token(registration)
    if not token:
        raise Exception("Cannot read as_token from registration file")

    rooms = get_rooms(homeserver, token)
    per_room_users = [get_users(homeserver, room, token, prefix, suffix) for room in rooms]
    merged_users = { k: v for d in per_room_users for k,v in d.items() }
    for uid, display in merged_users.iteritems():
        migrate_displayname(uid, display, suffix, homeserver, token)
        time.sleep(0.1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser("Remove (ircserver) suffix from users")
    parser.add_argument("-r", "--registration", help="The path to the AS registration file", required=True)
    parser.add_argument("-u", "--url", help="Base homeserver URL eg 'https://matrix.org'", required=True)
    parser.add_argument("-p", "--prefix", help="User prefix to determine which users to check. E.g. @freenode_", required=True)
    parser.add_argument("-s", "--suffix", help="Suffix to remove. E.g. (irc.freenode.net)", required=True)
    args = parser.parse_args()
    if not args.registration or not args.url or not args.prefix or not args.suffix:
        parser.print_help()
        sys.exit(1)
    if args.prefix[0] != "@":
        parser.print_help()
        print("--prefix must start with '@'")
        sys.exit(1)
    main(registration=args.registration, homeserver=args.url, prefix=args.prefix, suffix=args.suffix)
