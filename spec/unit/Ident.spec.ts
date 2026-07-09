import Ident from "../../lib/irc/Ident";

interface TestableIdent {
    respond(sock: { end: (data: string) => void }, localPort: string, remotePort: string,
        queryingAddress?: string): Promise<void>;
}

function fakeSocket() {
    let response = "";
    return {
        end: (data: string) => { response = data; },
        getResponse: () => response,
    };
}

describe("Ident", function() {
    beforeEach(() => {
        // Reset internal state between tests.
        Ident.configure({ port: 0, address: "127.0.0.1" });
    });

    it("answers a query from the address the connection was made to", async () => {
        Ident.setMapping("myuser", 4567, "1.2.3.4");
        const sock = fakeSocket();
        await (Ident as unknown as TestableIdent).respond(sock, "4567", "6667", "1.2.3.4");
        expect(sock.getResponse()).toEqual("4567,6667:USERID:UNIX:myuser\r\n");
    });

    it("refuses a query from a different address than the connection was made to", async () => {
        Ident.setMapping("myuser", 4568, "1.2.3.4");
        const sock = fakeSocket();
        await (Ident as unknown as TestableIdent).respond(sock, "4568", "6667", "9.9.9.9");
        expect(sock.getResponse()).toEqual("4568,6667:ERROR:NO-USER\r\n");
    });

    it("refuses a query for a mapping with no known remote address", async () => {
        Ident.setMapping("myuser", 4569, undefined);
        const sock = fakeSocket();
        await (Ident as unknown as TestableIdent).respond(sock, "4569", "6667", "1.2.3.4");
        expect(sock.getResponse()).toEqual("4569,6667:ERROR:NO-USER\r\n");
    });

    it("normalises IPv4-mapped IPv6 addresses before comparing", async () => {
        Ident.setMapping("myuser", 4570, "::ffff:1.2.3.4");
        const sock = fakeSocket();
        await (Ident as unknown as TestableIdent).respond(sock, "4570", "6667", "1.2.3.4");
        expect(sock.getResponse()).toEqual("4570,6667:USERID:UNIX:myuser\r\n");
    });

    it("refuses a query for an unknown port", async () => {
        const sock = fakeSocket();
        await (Ident as unknown as TestableIdent).respond(sock, "9999", "6667", "1.2.3.4");
        expect(sock.getResponse()).toEqual("9999,6667:ERROR:NO-USER\r\n");
    });
});
