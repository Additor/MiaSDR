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
const INVITED = { invitedEmail: "a@b.test", invitationId: "i" };

describe("Google button", () => {
  it("shows on the sign-in form only when the flag is on", () => {
    expect(renderToStaticMarkup(createElement(SignInForm, { googleEnabled: true }))).toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignInForm, { googleEnabled: false }))).not.toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignInForm, {}))).not.toContain(GOOGLE);
  });

  it("shows on the sign-up form only when the flag is on", () => {
    expect(renderToStaticMarkup(createElement(SignUpForm, { ...INVITED, googleEnabled: true }))).toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignUpForm, { ...INVITED, googleEnabled: false }))).not.toContain(GOOGLE);
    expect(renderToStaticMarkup(createElement(SignUpForm, INVITED))).not.toContain(GOOGLE);
  });
});
