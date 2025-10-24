Hi there! Please read the [CONTRIBUTING.md](https://github.com/matrix-org/matrix-appservice-bridge/blob/develop/CONTRIBUTING.md) guide for all matrix.org bridge
projects.

## Matrix-appservice-irc Guidelines

 - We use the [matrix.org-support](https://github.com/matrix-org/matrix-appservice-irc/labels/matrix.org-support) label for issues involving
   matrix.org-maintained bridges.
 - When creating an issue, please clearly state the IRC network you bridged to. If possible, please also state the IRCd (server implementation).
 - The official IRC bridge support/development room is [#irc:matrix.org](https://matrix.to/#/#irc:matrix.org)

### Doing a release

These steps are for the maintainers of the IRC bridge to refer to when doing a release.
When doing an RC release, suffix a `-rcV` to the tag.

* Ensure you have a Python3 env and then `pip install towncrier`
* `git checkout develop`
* Bump the version in `package.json`
* Run `./scripts/changelog-release.sh`
* `git commit CHANGELOG.md changelog.d package.json -m 'x.y.z'`
* `git tag x.y.z`
* `git push origin develop x.y.z`
* Create a release in GitHub
