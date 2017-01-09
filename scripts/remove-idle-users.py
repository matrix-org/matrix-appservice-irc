#!/usr/bin/env python
from __future__ import print_function
import argparse
import sys
import json
import urllib
import requests
import re

## debug request
import httplib as http_client
http_client.HTTPConnection.debuglevel = 1

def get_room_id(homeserver, alias, token):
    res = requests.get(homeserver + "/_matrix/client/r0/directory/room/" + urllib.quote(alias) + "?access_token=" + token).json()
    return res.get("room_id", None)

def get_last_active_ago(homeserver, user_id, token):
    res = requests.get(homeserver + "/_matrix/client/r0/presence/" + urllib.quote(user_id) + "/status?access_token=" + token).json()
    return res.get("last_active_ago", None)

def is_idle(homeserver, user_id, token, activity_threshold_ms):
    return get_last_active_ago(homeserver, user_id, token) > activity_threshold_ms

def get_idle_users(homeserver, room_id, token, since):
    res = requests.get(homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/members?access_token=" + token)
    user_ids = [event["state_key"] for event in res.json().get("chunk", None)]

    activity_threshold_ms = since * 24 * 60 * 60 * 1000

    return [user_id for user_id in user_ids if is_idle(homeserver, user_id, token, activity_threshold_ms)]

def kick_idlers(homeserver, homeserver_domain, room_id, token, since, user_template=None):
    reason = "Being idle for >%s days" % since

    user_ids = get_idle_users(homeserver, room_id, token, since)
    print("Kicking %s idle users from %s" % (len(user_ids), room_id))
    for user_id in user_ids:
        # Ignore unclaimed users, if user_template is specified
        if user_template and not claims_user_id(user_id, user_template, homeserver_domain):
            continue
        res = requests.post(
            homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/kick?access_token=" + token,
            data = json.dumps({
                "reason": reason,
                "user_id": user_id
            })
        )
        res.raise_for_status()

def claims_user_id(user_id, user_template, homeserver_domain):
    # the server claims the given user ID if the ID matches the user ID template.
    regex = template_to_regex(
        user_template,
        {
            "$SERVER": homeserver_domain
        },
        {
            "$NICK": "(.*)"
        },
        escapeRegExp(":" + homeserver_domain)
    )
    print("Matching %s to %s" % (regex, user_id))
    return re.match(regex, user_id)

def template_to_regex(template, literal_vars, regex_vars, suffix = ""):
    # The 'template' is a literal string with some special variables which need
    # to be find/replaced.
    regex = template;
    for k in literal_vars:
        regex = re.sub(escapeRegExp(k), regex, literal_vars[k])

    # at this point the template is still a literal string, so escape it before
    # applying the regex vars.
    regex = escapeRegExp(regex);
    # apply regex vars

    for k in regex_vars:
        regex = re.sub(
            # double escape, because we bluntly escaped the entire string before
            # so our match is now escaped.
            escapeRegExp(escapeRegExp(k)), regex, regex_vars[k]
        )

    return regex + suffix

def escapeRegExp(s):
    return re.escape(s);


def main(token, alias, homeserver, homeserver_domain, since, user_template):
    print("Removing idle users in %s" % alias)
    token = token
    room_id = get_room_id(homeserver, alias, token)
    if not room_id:
        raise Exception("Cannot resolve room alias to room_id")

    kick_idlers(homeserver, homeserver_domain, room_id, token, since, user_template)

if __name__ == "__main__":
    parser = argparse.ArgumentParser("Remove idle users from a given Matrix room")
    parser.add_argument("-t", "--token", help="The AS token", required=True)
    parser.add_argument("-a", "--alias", help="The alias of the room eg '#freenode_#matrix-dev:matrix.org'", required=True)
    parser.add_argument("-u", "--homeserver", help="Base homeserver URL eg 'https://matrix.org'", required=True)
    parser.add_argument("-d", "--domain", help=" matrix.org'", required=True)
    parser.add_argument("-s", "--since", type=int, help="Since idle users have been offline for", required=True)
    parser.add_argument("-e", "--template", help="User template to determine whether a user should be kicked. E.g. @$SERVER_$NICK", required=True)
    args = parser.parse_args()
    if not args.token or not args.alias or not args.homeserver:
        parser.print_help()
        sys.exit(1)
    main(token=args.token, alias=args.alias, homeserver=args.homeserver, homeserver_domain=args.domain, since=args.since, user_template=args.template)
