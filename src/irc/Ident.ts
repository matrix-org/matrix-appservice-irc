/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import net from "net";
import { getLogger } from "../logging";

const log = getLogger("irc-ident");

interface IdentConfig {
    port: number;
    address: string;
}

const DEFAULT_CONFIG = {
    port: 113,
    address: "0.0.0.0"
};

const CLIENT_CONNECTION_TIMEOUT_MS = 120000;

interface PortMapping {
    username: string;
    // The IRC server address the bridge connected to on this local port.
    // Ident queries are only answered if they come from this address, per
    // RFC1413 ("a user on address A may only query the server on address B
    // about connections between A and B"). Undefined if the connection type
    // doesn't let us know the remote address (e.g. pooled connections),
    // in which case queries for this mapping are never answered.
    remoteAddress?: string;
}

/**
 * Strip the IPv4-mapped IPv6 prefix (e.g. "::ffff:1.2.3.4" -> "1.2.3.4") so
 * that addresses can be compared consistently regardless of which family
 * Node reports them in.
 */
function normaliseAddress(address?: string): string|undefined {
    return address?.replace(/^::ffff:/, '');
}

/**
 * Runs an ident server to auth a list of usernames.
 *
 * This purposefully has no dependencies on any other library and is kept as
 * generic as possible. It consists of three functions:
 *
 * configure(opts) : opts => { port: {Number} }
 *      Configure the ident server.
 *
 * run()
 *      Start listening on the configured port for incoming requests.
 *
 * setMapping(username, port, remoteAddress) : username => {String}, port => {Number}, remoteAddress => {String}
 *      Assign a username/port mapping. Setting a port of 0 removes the mapping.
 **/
class IdentSrv {
    private config: IdentConfig = DEFAULT_CONFIG;
    private portMappings: {[port: string]: PortMapping} = {};
    private pendingConnections: Set<Promise<void>> = new Set();
    private isEnabled = false;

    public get enabled() {
        return this.isEnabled;
    }

    public run() {
        net.createServer(
            this.onConnection.bind(this)
        ).listen(this.config.port, this.config.address);
    }

    public configure(opts: IdentConfig) {
        log.info("Configuring ident server => %s", JSON.stringify(opts));
        this.config = opts;
        // This is only called if enabled.
        this.isEnabled = true;
    }

    public setMapping(username: string, port: number, remoteAddress?: string) {
        if (!this.isEnabled) {
            return;
        }
        if (port > 0) {
            this.portMappings[port] = { username, remoteAddress: normaliseAddress(remoteAddress) };
            log.debug("Set user %s on port %s (remote %s)", username, port, remoteAddress);
        }
        else if (port === 0) {
            Object.keys(this.portMappings)
                .filter((portNum: string) => this.portMappings[portNum].username === username)
                .forEach((portNum) => {
                    delete this.portMappings[portNum];
                    log.debug("Remove user %s from port %s", username, portNum);
                });
        }
    }

    private onConnection(sock: net.Socket) {
        log.debug("CONNECT %s %s", sock.remoteAddress, sock.remotePort);
        const queryingAddress = normaliseAddress(sock.remoteAddress);
        sock.on("data", (data) => {
            log.debug("DATA " + data);
            const ports = data.toString().split(",");
            const remoteConnectPort = Number(ports[1]);
            const localOutgoingPort = Number(ports[0]);
            if (!remoteConnectPort || !localOutgoingPort) {
                log.debug("BAD DATA");
                sock.end();
                return;
            }
            this.respond(sock,
                String(localOutgoingPort),
                String(remoteConnectPort),
                queryingAddress).catch(() => {
                // Just close the connection
                sock.end();
            });
        });
        sock.on("close", () => {
            log.debug("CLOSE");
        });
        sock.on("error", (err) => {
            log.error("connection error: " + err);
            if (err && err.stack) {
                log.error(err.stack);
            }
        });
    }

    public clientBegin(): () => void {
        if (!this.isEnabled) {
            return () => {
                // Not enabled, so no-op
            };
        }
        log.debug("IRC client started connection");
        let res!: () => void;
        const p: Promise<void> = new Promise((resolve) => {
            res = resolve;
            setTimeout(resolve, CLIENT_CONNECTION_TIMEOUT_MS);
        });
        this.pendingConnections.add(p);
        p.then(() => {
            log.debug("IRC client connected");
            this.pendingConnections.delete(p);
        })
        return res;
    }

    private async respond(sock: net.Socket, localPort: string, remotePort: string, queryingAddress?: string) {
        let mapping = this.portMappings[localPort];
        if (!mapping) {
            // Wait for pending connections to finish first.
            await Promise.all([...this.pendingConnections]);
            mapping = this.portMappings[localPort];
        }

        // Per RFC1413, only answer a query about a connection to the peer
        // that's actually party to that connection. Without this, anyone
        // who can reach the ident port could enumerate which Matrix users
        // are bridged to which IRC connections. If we don't know the
        // expected remote address for this mapping (e.g. pooled
        // connections don't currently report one), refuse rather than
        // trusting the query.
        let response;
        if (mapping && mapping.remoteAddress && mapping.remoteAddress === queryingAddress) {
            log.debug("Port %s is %s", localPort, mapping.username);
            response = `${localPort},${remotePort}:USERID:UNIX:${mapping.username}\r\n`;
        }
        else {
            if (mapping) {
                log.warn(
                    "Refusing ident query for port %s from %s (expected %s)",
                    localPort, queryingAddress, mapping.remoteAddress
                );
            }
            else {
                log.debug("No user on port %s", localPort);
            }
            response = `${localPort},${remotePort}:ERROR:NO-USER\r\n`;
        }
        log.debug(response);
        sock.end(response);
    }
}

export default new IdentSrv();
