"use strict";
const BridgedClient = require("../../lib/irc/BridgedClient.js");

describe("BridgedClient._getValidNick", () => {
  let client;

  beforeEach(() => {
    const serverMock = {
      domain: "example.net"
    }

    const ircClientConfigMock = {
      getDesiredNick: () => {
        return "a_nick";
      },

      getPassword: () => {
        return "p@$$w0rd";
      }
    }

    client = new BridgedClient(serverMock, ircClientConfigMock)
  })

  it("fails if the nick contains illegal characters", () => {
    expect(() => {client._getValidNick("S@l", true)}).
      toThrowError("Nick 'S@l' contains illegal characters.")

    expect(() => {client._getValidNick("B!ll", true)}).
      toThrowError("Nick 'B!ll' contains illegal characters.")

    expect(() => {client._getValidNick("Sa#", true)}).
      toThrowError("Nick 'Sa#' contains illegal characters.")

    expect(() => {client._getValidNick("Ca$h", true)}).
      toThrowError("Nick 'Ca$h' contains illegal characters.")

    expect(() => {client._getValidNick("two%", true)}).
      toThrowError("Nick 'two%' contains illegal characters.")

    expect(() => {client._getValidNick("b&", true)}).
      toThrowError("Nick 'b&' contains illegal characters.")

    expect(() => {client._getValidNick("A*", true)}).
      toThrowError("Nick 'A*' contains illegal characters.")

    expect(() => {client._getValidNick("main()", true)}).
      toThrowError("Nick 'main()' contains illegal characters.")

    expect(() => {client._getValidNick("quote\"", true)}).
      toThrowError("Nick 'quote\"' contains illegal characters.")

    expect(() => {client._getValidNick("f'", true)}).
      toThrowError("Nick 'f'' contains illegal characters.")

    expect(() => {client._getValidNick("sla/sh", true)}).
      toThrowError("Nick 'sla/sh' contains illegal characters.")

    expect(() => {client._getValidNick("dot.org", true)}).
      toThrowError("Nick 'dot.org' contains illegal characters.")

    expect(() => {client._getValidNick("C,S,V", true)}).
      toThrowError("Nick 'C,S,V' contains illegal characters.")

    expect(() => {client._getValidNick("one+one", true)}).
      toThrowError("Nick 'one+one' contains illegal characters.")

    expect(() => {client._getValidNick("soup_o<tag>", true)}).
      toThrowError("Nick 'soup_o<tag>' contains illegal characters.")

    expect(() => {client._getValidNick("wavey~", true)}).
      toThrowError("Nick 'wavey~' contains illegal characters.")

    expect(() => {client._getValidNick("y;", true)}).
      toThrowError("Nick 'y;' contains illegal characters.")

    expect(() => {client._getValidNick("x:y", true)}).
      toThrowError("Nick 'x:y' contains illegal characters.")

    expect(() => {client._getValidNick("what?", true)}).
      toThrowError("Nick 'what?' contains illegal characters.")

    expect(() => {client._getValidNick("hey!", true)}).
      toThrowError("Nick 'hey!' contains illegal characters.")
  })

  it("fails if the nick starts with a dash", () => {
    expect(() => {client._getValidNick("-Bob", true)}).
      toThrowError("Nick '-Bob' contains illegal characters.")
  })

  it("fails if the nick starts with a number", () => {
    expect(() => {client._getValidNick("2Bob", true)}).
      toThrowError("Nick '2Bob' must start with a letter.")
  })

  it("fails if the nick is longer than nine characters", () => {
    expect(() => {client._getValidNick("_123456789", true)}).
      toThrowError("Nick '_123456789' is too long. (Max: 9)")
  })

  it("returns the input nick if valid", () => {
    let uglyNick = "l33thax0r";
    expect(client._getValidNick(uglyNick, true)).toBe(uglyNick)
  })
})
