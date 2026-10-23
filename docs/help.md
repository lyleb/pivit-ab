# Who's who in pivitlab

Three kinds of people use pivitlab. The badge next to the logo tells you which one you are. The same steps are on the Help page in the dashboard.

## Who's who

1. Look at the badge next to the pivitlab logo.
2. **Platform admin** can see every agency. The badge says Platform admin. This person has the Users screen, can make an invite code for a new agency, and can open a read-only support view of another agency.
3. An **agency** is one company on pivitlab. People in it are an **Owner** or a **Member**. The badge says Owner or Member. An Owner runs the team. A Member can see the team and the tests, and cannot invite people or change them.
4. A **Viewer** is a read-only login for results. The badge says Viewer. A Viewer sees only the tests an Owner has assigned to them. They sign in with a username and password, not an email.

The names stored in the database stay as they are (`accounts`, `clients`, session role `client`). On screen the names are Platform admin, Agency, Owner, Member and Viewer.

## The Users screen

This screen is for a Platform admin. Stop a support view first. Users is hidden while you are viewing another agency.

1. Open **Users** in the sidebar.
2. Search by name, email or username. Use Type, Status and Agency to narrow the list. Archived people stay hidden until you tick **Show archived**.
3. To stop someone signing in, choose **Suspend** and confirm. They are signed out of every agency straight away. They cannot sign in until you choose **Unsuspend**.
4. To hide someone from lists, choose **Archive** and confirm. They disappear from lists and dropdowns in every agency, including the user filter on the audit log. They can still sign in until you also suspend them. **Restore** puts them back on the lists.
5. **Delete** is rare. It appears only when the person is already suspended or archived. Type their email, or a Viewer's username, exactly. pivitlab then removes their name, email or username, password and sign-in links, and their place in every agency. This cannot be undone. The audit log stays. The person is shown as "Deleted user" and a short code, not their name.

You cannot suspend, archive or delete yourself. pivitlab also refuses if that would leave no Platform admin, or no Owner for an agency. The screen says why.

## Agency invites

There are two invites. Do not mix them up.

A **new agency** starts from a code made by a Platform admin:

1. On Home, find **Invite codes**.
2. Add a note if you want, then choose **Create invite code**.
3. Copy the code. It is shown once, works once, and lasts 14 days. **Revoke** stops it.
4. Send the person to the sign-up page with that code. They enter a work email and a website.
5. That creates a new agency. It does not add them to an agency that already exists.

A **colleague** joins an agency that already exists. An Owner does this from Team:

1. Open **Team**.
2. Under **Invite someone**, enter their work email and choose Member or Owner.
3. Choose **Email the invite**, or **Create a link** if you would rather copy it. The link is shown once.
4. They open the link and press **Join this agency**. Opening the link does not use it up. The link works once and lasts 7 days.
5. Joining adds them to this agency. It does not create a new one. If they already use pivitlab, they are added to this agency.
6. **Pending invites** lists the ones still open. **Resend** emails a new link and replaces the previous one. **Revoke** stops it.

You cannot invite an address that is suspended or deleted. If they are already in the agency, the page says so.

## The Team page and Viewers

1. Open **Team**. An Owner and a Member can open it. Stop a support view first.
2. The list is everyone in this agency: Owners, Members and Viewers. Archived people stay hidden until you tick **Show archived**.
3. A Member can read the list. Only an Owner can change it. The page says so.
4. To change an Owner or a Member, choose Owner or Member in the Role menu. It saves when you change it. The agency must keep at least one Owner, so the last Owner's role cannot be changed.
5. To take an Owner or a Member out of this agency, choose **Remove** and confirm. They lose access here. They are not deleted from pivitlab, and any other agency they belong to is left as it is. You cannot remove yourself, and you cannot remove the last Owner.
6. To add a Viewer, fill in display name, username and a password of at least 8 characters, then choose **Create viewer**. Copy the password then. It is shown once.
7. On a Viewer's row, **Edit** changes the name or username. **Reset password** sets a new one, signs them out, and shows the new password once.
8. **Suspend** signs that Viewer out straight away. They cannot sign in until you choose **Unsuspend**. **Archive** hides them from this agency's lists. They can still sign in until you suspend them. **Restore** puts them back. Tick **Show archived** to see them.
9. Assign a Viewer to a test from that test's Settings tab, under Viewer. Leave it empty to keep the test internal. They only see the tests you assign.
10. Home also has a **Viewers** button. An Owner can create a Viewer, rename one, reset a password, or delete the login there. Delete removes that login and unassigns their tests. The tests stay. That is not the same as Delete on the Users screen.

## How sign-in works

Platform admin, Owner and Member:

1. Open the sign-in page and enter the work email.
2. Choose **Email me a sign-in link**.
3. The email has a link and a 6-digit code. Each lasts 15 minutes and works once.
4. The link opens a page where you press **Sign in**. A mail tool that only opens the link does not use it up. You can type the code instead.
5. You land on the dashboard. The badge shows Platform admin, Owner or Member.

A person creating a new agency uses the invite code first, then the same email. A colleague who was invited presses **Join this agency** and is signed in from that page.

An Owner or a Member stays signed in for 30 days of use, and never more than 90 days from sign-in. A Platform admin session lasts 12 hours and is not extended when they come back.

A Viewer:

1. Open the address the agency gave you, or choose **Viewer login** on the sign-in page. The address is `/login.html?role=client`.
2. Enter the username and password. There is no email sign-in for a Viewer.
3. You land on the results page. If you forget the password, ask the agency. An Owner resets it from Team.

When sign-in is closed:

1. **Suspend** stops sign-in at once, including a session that is already open.
2. **Archive** on its own does not stop sign-in.
3. A deleted person cannot sign in.
4. Asking for an email link still shows "If that address can be used, we've sent a link." Nothing is sent, and the page does not say why.
5. A Viewer whose password is right, but who is suspended or deleted, sees "That sign-in isn't available."

The password page at the unlisted address is only a fallback for the platform admin. Day to day, sign in by email. It is not linked from the sign-in page.

## The audit log

1. Open **Audit log** in the sidebar.
2. You see what happened in this agency, newest first. That includes sign-in, invites, sites, tests, and changes to people.
3. Choose a test, a user or an action, then **Apply filters**. **Clear** removes them. **Previous** and **Next** move through the list.
4. An Owner and a Member can open it. A Viewer cannot. A Platform admin sees their own agency, or the agency they are viewing. A support view is read-only, and starting or stopping it is written here.
5. Archived and deleted people drop out of the user filter, so old names do not pile up. The rows stay in the log.
6. After a delete, those rows name them as "Deleted user" and a short code, not their email or username.

**Sign out everywhere**, at the bottom of the sidebar, ends your other sessions.

## Single-page apps

A single-page app changes the address without loading the page again. The snippet notices history.pushState, history.replaceState, the back and forward buttons, and a hash change. An address that has not actually changed is ignored. Several changes within about a tenth of a second count as one, so pivitlab asks once for the address the visitor landed on.

On that change, pivitlab fetches the tests for the new address. A test that matches, and was not already applied on this page, is applied and its view is recorded once. A URL goal is checked again, and it still converts once for that visitor.

A test that was already applied stays applied until the next full load. Moving to another address does not remove it, and it is not applied a second time. Its page JavaScript does not run again. A full reload starts from the address in the browser.

To turn this off, add data-spa="off" to the snippet tag:

```html
<script src="https://pivitlab.com/snippet/ab.js"
        data-api="https://pivitlab.com"
        data-site="site_…"
        data-spa="off"></script>
```

Tests and URL goals are then evaluated only when the page fully loads. Send to GA4 still sends experience_impression again when the address changes, and still only once for the same address.

An address with ab_edit, or a preview token, is unchanged. It still opens that mode on a full load, and a later address change does not track it.

## Send to GA4

On Home, each site has **Send to GA4** and a box for that site's GA4 measurement ID. The ID starts with G-. This is included on paid plans. pivitlab has no priced plans yet. Paid plan is the switch that lets an agency use Send to GA4. A Platform admin sets it on Home, on the Send to GA4 card. That card also says how many sites have Send to GA4 switched on.

When Send to GA4 is switched on, the snippet sends that site's GA4 an event called `experience_impression`. The test name and id, and the variant name and id, are in the event. They are also joined in a parameter called `exp_variant_string`, which is the same shape VWO and Optimizely use. In GA4, register exp_variant_string as a custom dimension, then use it in a report or an exploration to compare variants.

pivitlab uses the gtag or dataLayer already on the page. It does not load Google Analytics, and it does not set Google cookies. If the page has neither, nothing is sent. If the page uses Google Tag Manager, pivitlab pushes one object onto dataLayer and does not also call gtag, so the visit is not counted twice. A page that uses gtag.js and not Tag Manager still receives the event through gtag. If Google Consent Mode is in use, the event is sent only when analytics storage is allowed. A preview, or a visit with ?pivit_qa=1, is not sent. Each test is sent once for a page view. A single-page app sends it again when the address changes, and not twice for the same address.

The downloadable container file adds a Data Layer Variable for each of those fields, at Version 2, a Custom Event trigger named experience_impression, and a GA4 Event tag named pivitlab - experience_impression. It does not add a Google tag. A gtag call would hide the fields from a Data Layer Variable, and sending both would count the visit twice.

### Set it up

#### GA4 through Tag Manager

1. On Home, open the site. Enter the measurement ID, the one that starts with G-, and choose Save GA4. Switch on Send to GA4 once a Platform admin has marked the agency as paid.
2. Open How Send to GA4 works, then choose Download Tag Manager container.
3. In Tag Manager, open Admin, then Import container.
4. Choose the file, then choose the workspace you want to import into.
5. Choose Merge. Then choose Rename conflicting tags, triggers and variables. Do not choose Overwrite. Overwrite would replace the whole container.
6. Open the tag named pivitlab - experience_impression and check the measurement ID is this site's G- ID. If you had not saved an ID, the file uses a variable named pivitlab - GA4 measurement ID. Put the G- ID in that variable.
7. The file does not add a Google tag. Keep the Google tag the site already has.
8. Choose Preview. Open the site with Tag Assistant. Do not add ?pivit_qa=1 to the address.
9. On a page in a running test, experience_impression should appear. exp_variant_string, experiment_id, experiment_name, variant_id and variant_name should show values, not undefined.
10. Publish the workspace.

#### GA4 directly with gtag.js

If the site loads gtag.js and does not use Tag Manager, you do not add a tag. pivitlab calls gtag with experience_impression and the same fields. Save the measurement ID and switch Send to GA4 on.

#### In GA4, for both paths

1. In GA4, open Admin, then Custom definitions.
2. Create a custom dimension. The scope is Event. The event parameter name is exp_variant_string. Give it a name you will recognise, such as Experiment variant.
3. Open DebugView. You should see experience_impression, with exp_variant_string on it.
4. A new event can take up to 24 hours to show in reports. DebugView is sooner.
5. To compare variants, open Explore and start a free-form exploration. Add the dimension Experiment variant, then add the metrics you care about, such as users or conversions.

#### If it does not work

- The event is missing. The test may not be running, or the page address does not match the test's URL rule. Paid plan or Send to GA4 may be off. Analytics consent may not be granted. A visit with ?pivit_qa=1 is not sent.
- The values are undefined. The Data Layer Variable names must match exactly: exp_variant_string, experiment_id, experiment_name, variant_id, variant_name.
- The visit is counted twice. Do not add both a gtag event and a Tag Manager tag for experience_impression. pivitlab sends only one of them.
