import { describe, expect, it } from "vitest";
import { isLocalOrigin } from "./linkedin-management";

describe("isLocalOrigin", () => {
  const local = [
    "http://localhost:3000",
    "http://LOCALHOST",
    "http://127.0.0.1:3000",
    "http://127.8.9.10",
    "http://[::1]:3000",
    "http://[::1]",
    "http://[::]:3000",
    "http://[::ffff:127.0.0.1]",
    "http://[fe80::1]",
    "http://[fd12:3456::1]",
    "http://0.0.0.0:3000",
    "http://10.0.0.5",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.20:8080",
    "http://169.254.169.254",
    "http://mia.local",
    "http://host.docker.internal:3000",
    "http://mia.localhost:3000",
    "http://mia",
    "http://mia:3000",
    "https://mia",
    "http://app-server:3000",
    "http://100.64.0.1",
    "http://100.100.50.20:3000",
    "http://100.127.255.255",
    "not a url",
  ];
  const publicOrigins = [
    "https://app.example.com",
    "https://app.example.com:8443",
    "http://172.15.0.1",
    "http://172.32.0.1",
    "http://11.0.0.1",
    "http://192.169.0.1",
    "http://8.8.8.8",
    "https://localhost.example.com",
    "https://notlocal.com",
    "https://10.example.com",
    "http://100.63.255.255",
    "http://100.128.0.1",
    "https://app.example.com.",
  ];

  it.each(local)("treats %s as local", (url) => {
    expect(isLocalOrigin(url)).toBe(true);
  });
  it.each(publicOrigins)("treats %s as public", (url) => {
    expect(isLocalOrigin(url)).toBe(false);
  });
});
