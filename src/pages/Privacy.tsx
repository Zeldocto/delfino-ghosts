import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/** Where privacy questions and requests go. */
const CONTACT_EMAIL = 'smsilmod@gmail.com'
const EFFECTIVE_DATE = '7 October 2026'

/**
 * Keep this page in step with the code. If you add a third party, a new table,
 * a cookie, analytics or anything else that touches visitor data, update the
 * matching section here in the same change.
 */
export function Privacy() {
  useDocumentTitle('Privacy Policy')
  return (
    <div className="page">
      <h1 className="page-title">Privacy Policy</h1>
      <p className="page-note">Effective {EFFECTIVE_DATE}</p>

      <div className="prose" style={{ marginTop: 16 }}>
        <p>
          Delfino Ghosts is a free, non-commercial community archive for Super Mario Sunshine ghost
          files, run by its maintainer (GitHub user Zeldocto). This policy explains what information
          the site collects, why, where it is stored, who it is shared with, and what happens to it
          when you delete your account. &ldquo;We&rdquo; and &ldquo;us&rdquo; below means the
          maintainer.
        </p>
        <p>
          The short version: you can browse and download without an account, and we collect no
          personal information from you beyond what our hosting providers log automatically. An
          account needs an email address and a password. Anything you put on your profile or upload
          is public. There are no ads, no analytics, no tracking cookies, and we never sell your
          information.
        </p>

        <h2>1. Information we collect</h2>
        <p>
          <strong>If you only browse or download.</strong> The site does not ask you for anything.
          Your browser still has to talk to our two hosting providers to load the site and its data,
          and they automatically receive technical information such as your IP address, browser
          type (user agent) and the time of the request. See section 3.
        </p>
        <p>
          <strong>When you create an account</strong>, you give us:
        </p>
        <ul>
          <li>your email address, used to sign you in, verify your account and reset your password;</li>
          <li>
            a password. It is sent over an encrypted connection to our authentication provider,
            Supabase, which stores only a one-way hash of it. We never see or store your password
            ourselves;
          </li>
          <li>a username, which is public.</li>
        </ul>
        <p>
          Supabase Auth also records account timestamps (when you signed up, confirmed your email
          and last signed in) and, for each signed-in session, the IP address and browser user agent
          it was created from. It keeps an authentication log of events such as sign-ups, sign-ins
          and password resets, including the IP address they came from. All of this is deleted
          along with your account.
        </p>
        <p>
          <strong>Your public profile.</strong> Optionally, a display name, an avatar link and a
          short bio. Your profile also shows public figures: when it was created, how many ghosts you
          have uploaded and how many counted downloads they have received.
        </p>
        <p>
          <strong>Ghosts you upload.</strong> The <code>.smsghost</code> file itself, exactly as
          uploaded, plus its original file name, size, title, description, level, time, tags, TAS
          flag, Moonshine version and upload date. A ghost file holds the recorded run data and labels
          Moonshine writes into it, such as the level, time, category and game disc id. All of this
          is public and downloadable by anyone. Do not put personal information in titles,
          descriptions, tags or file names.
        </p>
        <p>
          <strong>Download records.</strong> When a signed-in user downloads someone else&apos;s
          ghost, we record which account downloaded which ghost and when. This stops the same account
          inflating a ghost&apos;s download count more than once an hour. These records are not
          public; only you can read your own. The resulting download totals are public.
        </p>
        <p>
          <strong>Ghost files are checked in your browser.</strong> When you choose a file to upload,
          its header is read on your own device to check it is intact and to pre-fill the form. Nothing
          is sent anywhere until you press upload.
        </p>

        <h2>2. Cookies and browser storage</h2>
        <p>
          The site sets no cookies and uses no analytics, advertising or tracking scripts. It uses
          your browser&apos;s storage only for things the site needs to work:
        </p>
        <ul>
          <li>
            <code>delfino-ghosts-auth</code> (local storage): your sign-in session, only while you
            are signed in. Signing out or deleting your account removes it;
          </li>
          <li>
            <code>delfino-theme</code> (local storage): whether you chose the light or dark theme;
          </li>
          <li>
            <code>delfino:redirect</code> (session storage): the page you were opening, for a moment,
            so links straight to a page work on our host. It is deleted as soon as it is read.
          </li>
        </ul>
        <p>
          These stay on your device and are not used to track you. You can clear them at any time in
          your browser settings. Clearing <code>delfino-ghosts-auth</code> signs you out.
        </p>

        <h2>3. Where your information goes and who receives it</h2>
        <p>We do not sell or rent personal information, and we do not share it for advertising. It reaches only these parties:</p>
        <ul>
          <li>
            <strong>Supabase, Inc.</strong> (United States) provides our database, file storage
            and sign-in system, and sends our account verification and password reset emails. All
            account, profile, ghost and download data is stored with Supabase on Amazon Web Services
            in the <code>us-east-1</code> region (Northern Virginia, USA). Supabase receives the IP
            address and user agent of every request your browser makes to it, including from guests
            browsing or downloading, and keeps these in its service logs for a limited time. See{' '}
            <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">
              Supabase&apos;s privacy policy
            </a>
            .
          </li>
          <li>
            <strong>GitHub, Inc.</strong> (United States) hosts the website itself through GitHub
            Pages. When you load the site, GitHub receives your IP address and request details and
            may log them for security and to run the service. See the{' '}
            <a
              href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub Privacy Statement
            </a>
            .
          </li>
          <li>
            <strong>Avatar image hosts.</strong> Avatars are not stored by us. A profile&apos;s avatar
            is a link to an image on a site its owner chose, such as Imgur. When you view a page
            showing that avatar, your browser loads the image straight from that site, which then
            receives your IP address and browser details under its own privacy policy.
          </li>
          <li>
            <strong>Everyone.</strong> Your username, profile, ghosts and download totals are public
            on the site and can be viewed, downloaded and copied by anyone.
          </li>
          <li>
            <strong>When the law requires it.</strong> We may disclose information if we are legally
            required to, or where it is necessary to protect the site or its users from abuse.
          </li>
        </ul>
        <p>
          The &ldquo;Get Moonshine&rdquo; link takes you to GitHub, which is governed by its own
          privacy statement.
        </p>

        <h2>4. Why we use your information</h2>
        <ul>
          <li>
            <strong>To provide the service you signed up for</strong>: running your account, publishing
            your profile and ghosts, and sending account emails. For visitors in the EU, EEA or UK,
            the legal basis is performance of a contract.
          </li>
          <li>
            <strong>To keep the archive secure and its numbers fair</strong>: sign-in logs, the
            download records above and service logs. The legal basis is our legitimate interest in
            protecting the site and preventing abuse.
          </li>
          <li>
            <strong>To keep the archive complete after an account is deleted</strong>, as described
            in section 6. The legal basis is our legitimate interest, and the community&apos;s, in a
            stable public archive.
          </li>
        </ul>
        <p>We do not use your information for advertising, profiling or automated decision-making.</p>

        <h2>5. How long we keep it</h2>
        <ul>
          <li>Account and profile information: until you delete your account.</li>
          <li>Ghosts: until you delete them, or for as long as the archive exists (see section 6).</li>
          <li>Download records: until the account that made them is deleted.</li>
          <li>Sign-in history and sessions: until you delete your account.</li>
          <li>
            Service logs held by Supabase and GitHub: for the limited periods set by those providers.
          </li>
        </ul>

        <h2>6. Deleting your account</h2>
        <p>
          You can delete your account at any time from{' '}
          <Link to="/settings">Profile settings</Link>, after a confirmation step. Deletion takes
          effect immediately and cannot be undone.
        </p>
        <p>
          <strong>What is deleted:</strong> your email address, password hash, sign-in sessions, your
          sign-in history and the IP addresses recorded with it, and the record of every download you
          made. Your display name, avatar link and bio are cleared,
          and you are signed out.
        </p>
        <p>
          <strong>What becomes anonymous:</strong> your profile is renamed to an anonymous name such
          as &ldquo;Anonymous 1&rdquo;. It is no longer connected to any email address or login,
          and nobody, including you, can sign in to it, edit it or upload to it again. Its ghost and
          download totals stay as they are.
        </p>
        <p>
          <strong>What stays:</strong> every ghost you uploaded stays on the site, credited to that
          anonymous profile. The file, its details and its download count are kept, and it remains
          public and downloadable. Ghosts become part of the community archive once uploaded. By
          uploading one, you give Delfino Ghosts a permanent, worldwide, royalty-free permission to
          store, display and distribute it, which continues after your account is deleted. If you do
          not want a ghost to remain, delete it yourself before deleting your account. Your ghosts
          stay grouped together under the one anonymous profile, so anyone who already knew which
          ghosts were yours could still recognise them. Anything you wrote in a title, description or
          tag also stays.
        </p>
        <p>
          <strong>What may remain for a time:</strong> Supabase&apos;s and GitHub&apos;s own service
          logs, which record the IP addresses of requests to their systems and are removed when they
          expire under those providers&apos; retention periods. Copies other people downloaded before
          you deleted your account are outside our control.
        </p>
        <p>
          If something left in the archive contains personal information about you, such as your
          real name in a description, contact us (section 10) and we will remove that information.
        </p>

        <h2>7. Your rights</h2>
        <p>
          Depending on where you live, including under the EU and UK GDPR and US state laws such as
          the California Consumer Privacy Act, you may have the right to:
        </p>
        <ul>
          <li>access the personal information we hold about you and get a copy of it;</li>
          <li>
            correct it. You can change your username, display name, avatar and bio yourself in{' '}
            <Link to="/settings">Profile settings</Link>;
          </li>
          <li>delete it, as described in section 6;</li>
          <li>object to or restrict how we use it;</li>
          <li>receive it in a portable format;</li>
          <li>
            complain to your local data protection authority, if you are in the EU, EEA or UK.
          </li>
        </ul>
        <p>
          We do not sell or share personal information as those terms are defined in California
          law, and we will not treat you differently for exercising any of these rights. To make a
          request, contact us as described in section 10. We will respond within one month, may
          need to confirm the request comes from the account holder, and will not charge for it.
        </p>

        <h2>8. Children</h2>
        <p>
          You must be at least 13 years old to create an account. If you live somewhere that sets a
          higher age for agreeing to the use of your personal information online, which is up to 16
          in some EU countries, you need permission from a parent or guardian. Browsing and
          downloading need no account. If we learn that an account belongs to a child under 13, we
          will delete it. If you believe this has happened, please contact us.
        </p>

        <h2>9. Security and international transfers</h2>
        <p>
          All traffic to the site and to Supabase is encrypted with HTTPS. Database rules enforced
          by Supabase mean accounts can only change their own profile and ghosts, and passwords are
          never stored in readable form. No system is perfectly secure, and we cannot guarantee that
          information will never be accessed without permission. If a breach affects your personal
          information, we will notify you and the authorities where the law requires it.
        </p>
        <p>
          Our providers store and process information in the United States. If you use the site from
          elsewhere, including the EU, EEA or UK, your information is transferred to the United
          States. Those transfers rely on the safeguards our providers offer, such as the European
          Commission&apos;s Standard Contractual Clauses.
        </p>

        <h2>10. Contact</h2>
        <p>
          For privacy questions or requests, or to report personal information that should be
          removed, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. If your request is
          about your account, send it from the email address the account uses so we can confirm it is
          yours.
        </p>

        <h2>11. How AI was used to build this site</h2>
        <p>
          Delfino Ghosts was built with the help of AI coding assistants, including Anthropic&apos;s
          Claude, which wrote and suggested much of the code. All code was reviewed by the maintainer
          before being published to the site. The site has no AI features. Nothing you do on the site
          and none of your information is sent to any AI service.
        </p>

        <h2>12. Changes to this policy</h2>
        <p>
          If the way the site handles information changes, this page will be updated and the date at
          the top will change. If a change significantly affects how your information is used, we
          will post a notice on the site before it takes effect. Every past version of this page is
          kept in the project&apos;s public GitHub history.
        </p>
      </div>
    </div>
  )
}
