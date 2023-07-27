import { parseCommandFromEvent } from '../../lib/bridge/AdminRoomHandler';


describe("AdminRoomHandler", function() {
    describe("parseCommandFromEvent", function() {
        it('should be able to parse a command', () => {
            const result = parseCommandFromEvent({
                content: {
                    body: '!mytestarg hello'
                }
            });
            expect(result).withContext('command should parse').not.toBeNull();
            expect(result?.cmd).toEqual('mytestarg');
            expect(result?.args).toEqual(['hello']);
        });
        it('should be able to parse a command with a custom prefix', () => {
            const result = parseCommandFromEvent({
                content: {
                    body: '!foo mytestarg hello'
                }
            }, '!foo ');
            expect(result).withContext('command should parse').not.toBeNull();
            expect(result?.cmd).toEqual('mytestarg');
            expect(result?.args).toEqual(['hello']);
        });
        it('should ignore subsequent lines for args', () => {
            const result = parseCommandFromEvent({
                content: {
                    body: '!mytestarg hello\n foo'
                }
            });
            expect(result).withContext('command should parse').not.toBeNull();
            expect(result?.cmd).toEqual('mytestarg');
            expect(result?.args).toEqual(['hello']);
        });
        it('should ignore subsequent null terminated lines for args', () => {
            const result = parseCommandFromEvent({
                content: {
                    body: '!mytestarg hello\x00 foo'
                }
            });
            expect(result).withContext('command should parse').not.toBeNull();
            expect(result?.cmd).toEqual('mytestarg');
            expect(result?.args).toEqual(['hello']);
        });
        it('should ignore messages with an invalid body', () => {
            for (const body of [false, true, [], ['!foo'], 1, -1, 0, '', '!', undefined, null, NaN]) {
                expect(
                    parseCommandFromEvent({content: {body}})
                ).toBeNull();
            }
        });
        it('should ignore commands without the correct prefix', () => {
            const result = parseCommandFromEvent({
                content: {
                    body: 'mytestarg hello'
                }
            });
            expect(result).toBeNull();
        });
    });
});
