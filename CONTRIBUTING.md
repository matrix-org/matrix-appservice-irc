Hi there! Please read the [CONTRIBUTING.md](https://github.com/matrix-org/matrix-appservice-bridge/blob/develop/CONTRIBUTING.md) guide for all matrix.org bridge
projects.

## Matrix-appservice-irc Guidelines

 - We use the [matrix.org-support](https://github.com/matrix-org/matrix-appservice-irc/labels/matrix.org-support) label for issues involving
   matrix.org-maintained bridges.
 - When creating an issue, please clearly state the IRC network you bridged to. If possible, please also state the IRCd (server implementation).
 - The official IRC bridge support/development room is [#irc:matrix.org](https://matrix.to/#/#irc:matrix.org)

### Doing a release

These steps are for the maintainers of the IRC bridge to refer to when doing a release.
When doing an RC release, suffix a `-rcV` to the tag and version but NOT the branch.

* `git checkout develop`
* `git pull`
* `git switch -c release-v0.V.0`
* update package.json version number
* `npm install` to update package-lock.json
* `./scripts/changelog-release.sh`
* `git commit CHANGELOG.md changelog.d package.json package-lock.json -m 'v0.V.0'`
* `git tag --sign --message 'v0.V.0' '0.V.0'`
* `git push origin release-v0.V.0`
* `git push origin 0.V.0`
* [Make a release on GitHub](https://github.com/matrix-org/matrix-appservice-irc/releases), copying the changelog into the body and marking it as pre-release
* `npm publish`
