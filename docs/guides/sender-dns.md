# Sender DNS: SPF, DKIM and DMARC

Inbox providers check three DNS records on the domain you send from. Without them, mail from a new domain often lands in spam or gets refused. Set them on each domain a mailbox sends from, before the first campaign.

Settings, Mailboxes has a Sender DNS block that reads these records for each mailbox's domain and shows Found, Missing or Could not check. It only reads public DNS. It never stops a send.

The records below are for Google Workspace. Replace `example.com` with your domain. DNS changes can take up to 48 hours to reach everyone, and they usually arrive within an hour.

## SPF

SPF lists who may send mail for your domain. A domain has one SPF record, so if you already have one, add the `include` to it instead of adding a second record.

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` |

## DKIM

DKIM signs each message with a key your domain publishes. Google generates the key, so the value is yours alone.

1. Open the Google Admin console, then Apps, Google Workspace, Gmail, Authenticate email.
2. Pick the domain and select Generate new record. Use a 2048-bit key and leave the prefix selector as `google`.
3. Add the record it shows to your DNS.
4. Wait until the record is live, then select Start authentication in the same page.

| Type | Host | Value |
|---|---|---|
| TXT | `google._domainkey` | `v=DKIM1; k=rsa; p=` followed by the key Google generated |

The Sender DNS block reads the `google` selector only. If you chose another prefix, or another provider signs your mail, your DKIM can work while the block says Missing. Send yourself a message and look for `dkim=pass` under Show original in Gmail to confirm.

## DMARC

DMARC tells receivers what to do with mail that fails SPF and DKIM, and where to send reports. Start with `p=none`, which changes nothing and collects reports.

| Type | Host | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com` |

Once the reports show that your real mail passes, move to `p=quarantine` and later `p=reject`.

## Check the records

```sh
dig +short TXT example.com
dig +short TXT google._domainkey.example.com
dig +short TXT _dmarc.example.com
```

Google requires SPF or DKIM from everyone who sends to Gmail, and all three from anyone who sends 5,000 or more messages a day. MiaSDR adds the one-click unsubscribe header those rules also ask for.
