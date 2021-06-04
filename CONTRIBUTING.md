# Filing Issues
A good issue can mean the difference between a quick fix and a long, painful fixing process. That's why the
following guidelines exist:

 - Use the [Github issue tracker](https://github.com/matrix-org/matrix-appservice-irc/issues) to file your issues.
 - Write a short title which neatly summaries the *problem*. Do **not** write the *solution* in the issue title.
   For example: `Cannot create a nick with | in it` is a good issue title. `Filter nicks according to RFC 2812`
   is not a good issue title.
 - Give a summary and as much information (along with proposed solutions) as possible in the body of the issue.
 - Include reproduction steps where possible.
 - Provide the commit SHA or version number of the IRC bridge being used.
 - Provide the kind and version of the IRCd where known (e.g. `Unreal3.2.10.4`) - This information is usually
   provided when you initially connect to the IRC network. If unknown, provide the domain name of the IRC network.
   
Here is a good issue which takes into account these points:
```
Cannot create a nick with | in it
---------------------------------

I tried to change my nick using "!nick Foo|" but it was rejected with the error
message "Nick 'Foo|' contains illegal characters.". It is a valid character
according to RFC 2812, so the bridge shouldn't be rejecting it.

Reproduction:
 - Make a 1:1 room with the IRC bot.
 - Send the message "!nick Foo|".
 
Version: 0.3.0
IRC network: irc.freenode.net
```

# Making Pull Requests
This project follows "git flow" semantics. In practice, this means:
 - The `master` branch is latest current stable release.
 - The `develop` branch is where all the new code ends up.
 - When forking the project, fork from `develop` and then write your code.
 - Make sure your new code passes all the code checks (tests and linting). Do this by running
   `npm run check`.
 - Create a pull request. If this PR fixes an issue, link to it by referring to its number.
 - PRs from community members must be signed off as per Synapse's [Sign off section](https://github.com/matrix-org/synapse/blob/master/CONTRIBUTING.md#sign-off)
 - Create a changelog entry in `changelog.d`. A changelog filename should be `${GithubPRNumber}.{bugfix|misc|feature|doc|removal}`
   The change should include information that is useful to the user rather than the developer.
   You can choose to sign your changelog entry to be credited by appending something like "Thanks to @Half-Shot"
   at the end of the file, on the same line.

## Coding notes
The IRC bridge is compatible on Node.js v10+. Buildkite is used to ensure that tests will run on
supported environments. Code should not use any ES features greater than that supported in ES2018.
Please see http://node.green/ for a list of supported features.
 
Tests are written in Jasmine. Depending on the pull request, you may be asked to write tests for
new code.

## Release notes
 - Changes are put in `CHANGELOG.md`.
 - Each formal release corresponds to a branch which is of the form `vX.Y.Z` where `X.Y.Z` maps
   directly onto the `package.json` (NPM) version.
 - Releases are also tagged so they are present on the Releases page on Github.
 - Releases should be signed by the maintainer's key.

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
