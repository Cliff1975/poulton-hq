# Poulton HQ

Cliff Poulton's daily operations dashboard for Poulton Consultancy: the agent circle, the approval queue, tasks, the sales pipeline, the agent schedule, and branded email templates.

## Deploy on Render (about 10 minutes)

1. **GitHub:** create a **private** repository called `poulton-hq` and upload these files (keep the `public/` folder).
2. **Render:** go to New → Blueprint, connect the repository, and Render reads `render.yaml`.
3. When asked, type a strong password for **DASH_PASS** (at least 16 characters). Your username is `cliff`.
4. Deploy. Open the `.onrender.com` link, sign in, and bookmark it on your phone and laptop.

**Cost:** the Starter plan plus a 1 GB disk keeps your data safe between restarts. Check Render's pricing page for the current price. On the free plan the page still works, but saved data can be lost whenever the service restarts. If you use the free plan, download a backup from the *Backup & export* tab every week.

## How your data is secured
- The repository is private and contains no client data: your entries live only on the Render disk (`/var/data/state.json`).
- Every page and API call needs your password (HTTPS + Basic Auth). The password is stored as a Render secret, never in GitHub.
- A dated copy of your data is kept once a day on the disk, and you can download a JSON backup at any time.
- Don't put card numbers, passwords or ID numbers in the dashboard.

## Update the dashboard
Edit `public/index.html`, commit to GitHub, and Render redeploys automatically.

## Gmail link cleaner (one-click links in agent drafts)

Drafts saved by the Claude Gmail connector have every link wrapped in a google.com/url redirect. HQ connects to Gmail itself (scope `gmail.compose`, drafts only) and puts the real links back every 5 minutes. It never sends, deletes or reads received mail.

One-time setup (about 10 minutes):
1. Go to console.cloud.google.com while signed in as info@poultonconsults.com and create a project called "Poulton HQ".
2. APIs & Services > Library: enable the **Gmail API**.
3. APIs & Services > OAuth consent screen: choose **Internal** (Google Workspace), app name "Poulton HQ", support email info@poultonconsults.com. Add the scope `.../auth/gmail.compose`.
4. APIs & Services > Credentials > Create credentials > OAuth client ID > **Web application**. Authorised redirect URI: `https://poulton-hq.onrender.com/oauth/google/callback`. Copy the Client ID and Client secret.
5. Render > poulton-hq > Environment: add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BASE_URL` = `https://poulton-hq.onrender.com`. Save (Render redeploys).
6. Open HQ > **Gmail links** > **Connect Gmail**, approve, and you land back on the page showing "Connected". Press **Clean drafts now** to fix every existing draft straight away.

If the HQ address is different, use it in steps 4 and 5.
