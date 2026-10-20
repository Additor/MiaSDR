# Gmail setup (service account with domain-wide delegation)

MiaSDR sends and reads mail through the Gmail API. A Google Cloud service account acts as each mailbox, so you do not click through an OAuth consent screen per user. This needs a Google Workspace domain and a Workspace super admin. A free personal Gmail account cannot use domain-wide delegation.

Plan for 20 to 30 minutes the first time. Replace every `<placeholder>` below with your own value.

## 1. Create a Google Cloud project

1. Open https://console.cloud.google.com and sign in with your Workspace admin account.
2. Open the project picker, choose **New project**, and name it (for example `miasdr-mail`). Pick your organization as the parent.
3. Note the project id. It looks like `<project-id>`.

## 2. Enable the Gmail API

1. In the project, open **APIs & Services > Library**.
2. Search for **Gmail API** and click **Enable**.

## 3. Create the service account

1. Open **IAM & Admin > Service Accounts** and click **Create service account**.
2. Name it (for example `miasdr`). Skip the optional role and user access steps.
3. Open the new account, go to **Details**, and copy the **Unique ID**. This number is the client ID you register in step 6. It also appears as `client_id` in the JSON key.

## 4. Allow key creation (organization policy)

Organizations created after 2024 enforce the policy `iam.disableServiceAccountKeyCreation` by default. If it applies to you, the **Keys > Add key** step fails with "Service account key creation is disabled". Override the policy on this project only:

1. Your Google account needs the **Organization Policy Administrator** role (`roles/orgpolicy.policyAdmin`) at the organization level. A super admin can grant it in **IAM & Admin > IAM** after switching the project picker to the organization.
2. Switch the project picker back to your project and open **IAM & Admin > Organization Policies**.
3. Search for `Disable service account key creation` (constraint `iam.disableServiceAccountKeyCreation`) and click it.
4. Click **Manage policy**, choose **Override parent's policy**, add a rule, set enforcement to **Off**, and save.
5. Wait one to two minutes for the change to apply.

Leave the policy enforced on your other projects.

## 5. Create the JSON key

1. Open the service account, go to **Keys > Add key > Create new key**, choose **JSON**, and click **Create**.
2. The browser downloads the file. Store it outside the repository, for example `./secrets/google-service-account.json`. Never commit it. Anyone holding this file can act as every mailbox you delegate.

## 6. Register domain-wide delegation

A Workspace super admin does this in the admin console:

1. Open https://admin.google.com and go to **Security > Access and data control > API controls**. (Older consoles show **Security > API controls**.)
2. Under **Domain-wide delegation**, click **Manage domain-wide delegation**, then **Add new**.
3. Enter the **Client ID** from step 3 (the numeric Unique ID).
4. Enter these OAuth scopes, comma separated, with no spaces:

   ```
   https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify
   ```

5. Click **Authorize**. Changes can take a few minutes, and up to 24 hours in rare cases.

## 7. Give the key to MiaSDR

Option A, a mounted file (recommended). Put the key at `./secrets/google-service-account.json`, then uncomment the volume in `docker-compose.yml`:

```yaml
volumes:
  - ./secrets/google-service-account.json:/run/secrets/google-service-account.json:ro
```

Set these in `.env`:

```
MAILBOX_PROVIDER=gmail
GOOGLE_SERVICE_ACCOUNT_FILE=/run/secrets/google-service-account.json
```

Option B, raw JSON. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the whole key on one line. If both are set, the JSON wins.

Restart with `docker compose up -d`. A missing or malformed key does not stop the app. It disables the email jobs and logs `Email jobs disabled: <reason>` (see `docker compose logs app`).

## 8. Connect the mailbox

1. Sign in as an owner or admin and open **Settings > Mailboxes** (`/settings/mailboxes`).
2. Enter the Workspace address to send from (it must be a user in your domain) and an optional sender name.
3. MiaSDR asks Google for a token as that user and reads the profile. On success the mailbox shows as connected. On failure it shows a readable reason.
4. Set the emails per day (1 to 200, default 30), the time zone, the working days and the hours.

The first inbox sync stores a starting point and ingests nothing. Replies that arrived before that moment do not appear.

## Troubleshooting

| Symptom or message | Cause | Fix |
| --- | --- | --- |
| `unauthorized_client` | The client ID is not registered for domain-wide delegation, or the scopes differ from the three above. | Redo step 6 with the numeric Unique ID and all three scopes. Wait a few minutes. |
| `invalid_grant` | The mailbox is not a user in your Workspace domain, the delegation is not active yet, or the server clock is wrong. | Check the address spelling, wait, and check the host clock with `date -u`. |
| `403` from Gmail on send or sync | A scope is missing from the delegation entry, or the Gmail API is not enabled in the project. | Add the missing scope in admin.google.com. Confirm step 2. |
| `404` from Gmail | The address does not exist in your domain. | Use a real user mailbox in your domain. |
| Key creation disabled when you click Create | The organization policy `iam.disableServiceAccountKeyCreation` is enforced. | Follow step 4. You need Organization Policy Administrator. |
| `The Google service account key is not valid JSON` or `needs client_email and private_key` | The key is truncated or edited. | Download a fresh key. Paste it unmodified. |
| `Could not read the Google service account key file` | The volume is not mounted or the path differs. | Check the volume line and `GOOGLE_SERVICE_ACCOUNT_FILE`. Run `docker compose exec app ls /run/secrets`. |
| `Google is not connected yet` when connecting a mailbox | `MAILBOX_PROVIDER` is empty. | Set `MAILBOX_PROVIDER=gmail` and restart. |
| Campaign started but nothing sends | The mailbox is outside its working hours, at its daily limit, or waiting out the gap between sends. | See [operations](../operations.md). New organizations default to Monday to Friday, 09:00 to 18:00 in the time zone saved at setup (UTC if none was saved). Check the time zone on the mailbox. |

## Security notes

- Delegation covers every address in the domain, so MiaSDR limits which addresses an organization can connect. Set `MAILBOX_ALLOWED_DOMAINS` (comma list, for example `example.com,example.org`) to the domains your tenants own. With `AUTH_SIGNUP=open` the variable is required: without it nobody can connect a mailbox, because any visitor could otherwise connect an executive's address. With `AUTH_SIGNUP=invite-only` and no list, any address in the Workspace domain can be connected by an owner or admin, so only invite people you trust with the whole domain. The same limit holds with several tenant organizations on one invite-only instance: with no list, any admin of any organization can connect any address in the Workspace. Operators of a multi-tenant instance must set `MAILBOX_ALLOWED_DOMAINS`.
- The list is enforced again at send time. A connected mailbox outside the list (connected before you narrowed it) sends nothing, shows "Blocked: outside MAILBOX_ALLOWED_DOMAINS" on the mailboxes page, and counts in `blocked_by_domain_policy` on the `email.send` job. With `AUTH_SIGNUP=open` and no list, no mailbox sends, and the job logs the reason once per tick.
- Mailboxes connected before you set the list stay connected. Retesting one outside the list marks it failed with the reason.
- The key can act as any user in the domain for the three scopes. Keep the file mode at `600` and out of backups you share.
- Rotate the key by creating a second key, switching `GOOGLE_SERVICE_ACCOUNT_FILE` to it, restarting, then deleting the old key in the console.
