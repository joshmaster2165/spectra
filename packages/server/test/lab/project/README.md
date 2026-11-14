# Lab Shop — authorized test engagement

Target: the Lab Shop application, running locally for testing.

- Start at: http://shop.lab.localhost:4420
- In scope: `lab.localhost` and every subdomain of it, on port 4420 only.
- Out of scope: everything else, including any third-party hosts the app references.
- Test accounts: any credentials log in through the API's login endpoint.
- Rules: recon and light confirmation only. No brute force beyond the wordlists here, no denial of service.

Wordlists are in `wordlists/`.
