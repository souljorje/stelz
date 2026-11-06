import { describe, expect, test } from "bun:test";
import { emptyProxyFields, normalizeProxyInput, parseProxyInput, parseProxyList, proxyFromFields } from "../../src/profiles/proxy-input.ts";
import { validateProxy } from "../../src/profiles/proxy-url.ts";

describe("provider proxy input", () => {
  test.each([
    ["http://reader:secret@proxy.test:8080", "http://reader:secret@proxy.test:8080", false],
    ["reader:secret@proxy.test:8080", "http://reader:secret@proxy.test:8080", true],
    ["proxy.test:8080:reader:secret", "http://reader:secret@proxy.test:8080", true],
    ["proxy.test:8080", "http://proxy.test:8080", true],
    ["  https://proxy.test  ", "https://proxy.test", false],
    ["socks5://[2001:db8::1]:1080", "socks5://[2001:db8::1]:1080", false],
    ["[2001:db8::1]:8080:reader:secret", "http://reader:secret@[2001:db8::1]:8080", true],
    ["HTTPS://reader:secret@PROXY.test:8443/", "https://reader:secret@proxy.test:8443", false],
    ["http://:secret@proxy.test:8080", "http://:secret@proxy.test:8080", false],
  ])("normalizes %s", (input, expected, assumedProtocol) => {
    const parsed = parseProxyInput(input);
    expect(parsed).toMatchObject({ kind: "proxy", url: expected, assumedProtocol });
    expect(normalizeProxyInput(input)).toBe(expected);
    if (parsed.kind === "proxy") {
      expect(validateProxy(parsed.url).hostname).toBe(parsed.fields.host);
      expect(parsed.display).not.toMatch(/reader|secret/);
      expect(normalizeProxyInput(parsed.url)).toBe(parsed.url);
    }
  });

  test("encodes literal shorthand passwords and decodes existing URL credentials exactly once", () => {
    const password = "p@ss:word/#?%20 ' \\\"";
    const shorthand = normalizeProxyInput(`proxy.test:8080:reader:${password}`);
    expect(decodeURIComponent(new URL(shorthand).password)).toBe(password);
    expect(shorthand).not.toMatch(/[\s'"#\\]/);
    const escaped = normalizeProxyInput("http://r%40eader:pass%2520%23%40@proxy.test:8080");
    expect(decodeURIComponent(new URL(escaped).username)).toBe("r@eader");
    expect(decodeURIComponent(new URL(escaped).password)).toBe("pass%20#@");
    expect(decodeURIComponent(new URL(normalizeProxyInput("http://user:100%done@proxy.test:8080")).password)).toBe("100%done");
    expect(decodeURIComponent(new URL(normalizeProxyInput("proxy.test:8080:reader: secret \n")).password)).toBe(" secret ");
  });

  test("separate fields preserve literal credentials and support IPv6", () => {
    const parsed = proxyFromFields({ protocol: "https", host: "2001:db8::2", port: "443", username: "u:ser", password: "a%20b\"'" });
    expect(parsed.kind).toBe("proxy");
    if (parsed.kind !== "proxy") throw Error("Expected a proxy");
    expect(decodeURIComponent(new URL(parsed.url).username)).toBe("u:ser");
    expect(decodeURIComponent(new URL(parsed.url).password)).toBe("a%20b\"'");
    expect(parsed.display).toBe("https://[2001:db8::2]:443");
  });

  test.each([
    "curl 'https://example.test/check' -x proxy.test:8080 -U 'reader:pa:ss@word'",
    'curl --proxy="proxy.test:8080" --proxy-user="reader:pa:ss@word" https://example.test',
    "curl -xproxy.test:8080 -Ureader:pa:ss@word https://example.test",
    "curl \\\n  -U 'reader:pa:ss@word' \\\n  --proxy 'http://proxy.test:8080' https://example.test",
  ])("extracts cURL proxy options without running the command", input => {
    expect(normalizeProxyInput(input)).toBe("http://reader:pa%3Ass%40word@proxy.test:8080");
  });

  test.each([
    "curl -x proxy.test:8080 -U \"reader:$PASSWORD\"",
    "curl -x proxy.test:8080 -U reader:$(whoami)",
    "curl -x proxy.test:8080; touch /tmp/not-executed",
    "curl -x proxy.test:8080 | sh",
    "curl -x first.test:8080 -x second.test:8080",
    "curl -x http://reader:secret@proxy.test:8080 -U reader:second",
    "curl -x proxy.test:8080 --config credentials.txt",
    "curl --socks5 proxy.test:1080",
    "curl -x proxy.test:8080 -U 'unfinished",
    "curl -x https://provider.test/download?token=private",
    "curl -- -x proxy.test:8080",
  ])("rejects unclear cURL input", input => expect(parseProxyInput(input).kind).toBe("invalid"));

  test("quoted command syntax is a literal password, never an instruction", () => {
    const url = normalizeProxyInput("curl -x proxy.test:8080 -U 'reader:$(touch /tmp/not-executed)' https://example.test");
    expect(decodeURIComponent(new URL(url).password)).toBe("$(touch /tmp/not-executed)");
  });

  test("cURL request values cannot be mistaken for proxy options", () => {
    expect(normalizeProxyInput("curl -x proxy.test:8080 -H '-Ureader:secret' --data '-xother.test:8080' https://example.test"))
      .toBe("http://proxy.test:8080");
    expect(parseProxyInput("curl -x proxy.test:8080 --unknown '-Ureader:secret'").kind).toBe("invalid");
    expect(normalizeProxyInput("curl -sSL -x proxy.test:8080 --proxy-basic -U reader:secret https://example.test"))
      .toBe("http://reader:secret@proxy.test:8080");
  });

  test.each([
    "socks5://reader:secret@proxy.test:1080", "ftp://proxy.test:21", "proxy.test:0", "proxy.test:65536",
    "proxy.test:abc", "2001:db8::1:8080", "http://proxy.test:8080#secret", "bad-secret",
    "http://proxy.test:8080\u0000", "http://reader:secret\u202e@proxy.test:8080", "a".repeat(8193),
    "user:8080:reader:secret@proxy.test:8080",
  ])("rejects invalid or ambiguous addresses", input => {
    expect(parseProxyInput(input).kind).toBe("invalid");
    expect(() => normalizeProxyInput(input)).toThrow();
  });

  test("unsupported SOCKS5 auth retains fields for correction and never becomes direct", () => {
    expect(parseProxyInput("socks5://reader:secret@proxy.test:1080")).toMatchObject({ kind: "invalid", fields: { protocol: "socks5", host: "proxy.test" } });
    expect(() => normalizeProxyInput("")).toThrow("Remove the proxy explicitly");
    expect(parseProxyInput(" ")).toEqual({ kind: "empty" });
    expect(proxyFromFields({ ...emptyProxyFields(), host: "proxy.test", password: "secret" }).kind).toBe("proxy");
  });

  test("separates download links and lists from endpoints", () => {
    expect(parseProxyInput("https://provider.test/download?token=private")).toMatchObject({ kind: "link" });
    expect(parseProxyInput("proxy.test:8080\nother.test:8080")).toEqual({ kind: "list" });
    expect(() => normalizeProxyInput("https://provider.test/download?token=private")).toThrow("select one proxy");
    expect(() => normalizeProxyInput("proxy.test:8080\nother.test:8080")).toThrow("select one proxy");
    expect(parseProxyInput("https://provider.test/list?email=reader@proxy.test:8080").kind).toBe("link");
    expect(parseProxyInput("http://reader:secret@provider.test/path@proxy.test:8080").kind).toBe("invalid");
  });

  test("list import deduplicates endpoints with matching credentials and reports invalid lines without secrets", () => {
    const parsed = parseProxyList("# exported list\nproxy.test:8080:reader:secret\nhttp://reader:secret@proxy.test:8080\nproxy.test:8080:reader:other\ninvalid-private-secret\n");
    expect(parsed.proxies).toHaveLength(2);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.line).toBe(5);
    expect(JSON.stringify(parsed.errors)).not.toContain("private-secret");
    expect(() => parseProxyList("x".repeat(1024 * 1024 + 1))).toThrow("smaller than 1 MB");
  });
});
