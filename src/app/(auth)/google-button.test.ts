import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/contexts/identity/infrastructure/auth-client", () => ({ authClient: { signIn: { social: vi.fn() } } }));

import { SignInForm } from "./sign-in/sign-in-form";
import { SignUpForm } from "./sign-up/sign-up-form";

const GOOGLE = "Continue with Google";

describe("Google button", () => {
  it("shows on the sign-in form only when the flag is on", () => {
    expect(renderToStaticMarkup(createElement(SignInForm, { signupAvailable: false, googleEnabled: true }))).toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignInForm, { signupAvailable: false, googleEnabled: false }))).not.toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignInForm, { signupAvailable: false }))).not.toContain(GOOGLE);
  });

  it("shows on the sign-up form only when the flag is on, including for an invited person", () => {
    expect(renderToStaticMarkup(createElement(SignUpForm, { googleEnabled: true }))).toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignUpForm, { googleEnabled: true, invitedEmail: "a@b.test", invitationId: "i" }))).toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignUpForm, { googleEnabled: false }))).not.toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignUpForm, {}))).not.toContain(GOOGLE);
  });
});
