A wishlist of IRC networks to be bridged is being collected [in a github issue](https://github.com/matrix-org/matrix-appservice-irc/issues/208).

<table>
    <tr>
        <th>Network Name</th>
        <th>Room alias format</th>
        <th>Appservice user</th>
        <th>Room for Support</th>
        <th>Operator</th>
    </tr>
    <tr>
        <td>darkfasel</td>
        <td>#channame:darkfasel.net</td>
        <td>@IRC-Darkfasel:darkfasel.net</td>
        <td>#darkfasel:darkfasel.net</td>
        <td>darkfasel</td>
    </tr>
    <tr>
        <td>fc00</td>
        <td>#fc00-irc_#channame:m.trnsz.com</td>
        <td>@fc00ircmtx:m.trnsz.com</td>
        <td>None</td>
        <td></td>
    </tr>
    <tr>
        <td>freenode<a href="#user-content-foot1"><sup>[1]</sup></a></td>
        <td>#freenode_#channame:matrix.org</td>
        <td>@appservice-irc:matrix.org<a href="#user-content-foot2"><sup>[2]</sup></a></td>
        <td>#irc:matrix.org</td>
        <td>Matrix.org</td>
    </tr>
    <tr>
        <td>GIMPNet<a href="#user-content-foot3"><sup>[3]</sup></a></td>
        <td>#_gimpnet_#channame:gnome.org</td>
        <td>@gimpnet-irc:gnome.org<a href="#user-content-foot4"><sup>[4]</sup></a></td>
        <td>#irc:matrix.org</td>
        <td>Matrix.org / Gnome.org </td>
    </tr>
    <tr>
        <td>IRCnet</td>
        <td>#_ircnet_#channame:irc.snt.utwente.nl</td>
        <td>@ircnet:irc.snt.utwente.nl</td>
        <td>#ircnet:utwente.io</td>
        <td>SNT</td>
    </tr>
    <tr>
        <td>OFTC</td>
        <td>#_oftc_#channame:matrix.org</td>
        <td>@oftc-irc:matrix.org</td>
        <td>#irc:matrix.org</td>
        <td>Matrix.org</td>
    </tr>
    <tr>
        <td>PirateIRC</td>
        <td>#pirateirc_#channame:diasp.in</td>
        <td>@pirateirc:diasp.in</td>
        <td>#diasp.in:diasp.in</td>
        <td>Indian Pirates</td>
    </tr>
    <tr>
        <td>Snoonet</td>
        <td>#_snoonet_#channame:matrix.org</td>
        <td>@snoonet-irc:matrix.org</td>
        <td>#irc:matrix.org</td>
        <td>Matrix.org</td>
    </tr>
    <tr>
        <td>Tweakers.net</td>
        <td>#_tweakers_#channame:irc.snt.utwente.nl</td>
        <td>@tweakers:irc.snt.utwente.nl</td>
        <td>#tweakers-irc:utwente.io</td>
        <td>SNT</td>
    </tr>
    <tr>
        <td>irchighway</td>
        <td>#irchighway_#channame:eggy.cc</td>
        <td>@appservice-irc:eggy.cc</td>
        <td>#eggster:eggy.cc</td>
        <td>Eggy</td>
    </tr>
    <tr>
        <td>W3C</td>
        <td>#_w3c_#channame:matrix.org</td>
        <td>@w3c-irc:matrix.org</td>
        <td>#irc:matrix.org</td>
        <td>Matrix.org</td>
    </tr>
</table>

### Footnotes

1. <a name="foot1"></a>Freenode doesn't have the leading `_` as it is older than the practice of putting the underscore to the beginning.
2. <a name="foot2"></a>This appservice user doesn't have "freenode" in its name because in the past it was used for _all_ matrix.org-hosted bridges.
3. <a name="foot3"></a>This includes both irc.gimp.org and irc.gnome.org, as they are the same thing.
4. <a name="foot6"></a>The bridge has moved from matrix.org to gnome.org.

* Hackint [closed their Matrix bridge](https://hackint.org/archive#20181028_Matrix_Bridging_Sunset) on 2018-12-31.
* Random.sh is no longer contactable. Status of the bridge is unknown.
* Foonetic IRC has shut down. #xkcd channels [moved to slashnet](https://web.archive.org/web/20190824061533/http://wiki.xkcd.com/irc/Main_Page#Channel_Migration)
* The espernet bridge was shut down after the 2019 matrix.org network breach.
* The Moznet IRC network has been shut down. They now run their own Matrix homeserver at chat.mozilla.org 🎉
