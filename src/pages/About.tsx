import { Link } from 'react-router-dom'
import { MOONSHINE_RELEASES_URL } from '../components/Navbar'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { GHOST_LIMIT } from '../types'

export function About() {
  useDocumentTitle('About')
  return (
    <div className="page">
      <h1 className="page-title">About</h1>

      <div className="prose" style={{ marginTop: 16 }}>
        <p>
          Delfino Ghosts is a shared shelf for Super Mario Sunshine ghosts. Runners upload the files
          Moonshine writes, everyone else takes them. There is no feed, no voting and no comments —
          the archive exists so a ghost you recorded once is still findable years later.
        </p>

        <h2>Moonshine</h2>
        <p>
          Moonshine is the Super Mario Sunshine practice mod. Among other things it records and
          replays ghosts, so you can run a level against your own best attempt or against someone
          else&apos;s. Builds are published on{' '}
          <a href={MOONSHINE_RELEASES_URL} target="_blank" rel="noopener noreferrer">
            the Moonshine releases page
          </a>
          .
        </p>

        <h2>What a ghost file is</h2>
        <p>
          A <code>.smsghost</code> file is a small binary container holding the inputs and state
          Moonshine recorded for one run, along with a label like the level and final time, the disc
          id it was recorded against, and checksums covering both the header and the recorded data.
        </p>
        <p>
          When you pick a file to upload, the site reads that header in your browser to check the
          container is intact and to pre-fill the form. The bytes themselves are stored and served
          untouched.
        </p>

        <h2>Uploading</h2>
        <p>
          Sign in and open <Link to="/upload">Upload</Link>. You can drop a whole folder of ghosts
          at once. Each file is read on arrival, so titles and versions arrive filled in, and you
          can adjust each one before sending. A description is optional but makes a ghost far more
          useful to the next person: route, setup, what to watch for. Each account can hold up to {GHOST_LIMIT} ghosts; you can delete
          your own at any time to make room.
        </p>

        <h2>Downloading</h2>
        <p>
          Anyone can download anything here without an account. The difference an account makes is
          bookkeeping: a download only moves a ghost&apos;s counter when the person downloading is
          signed in and is not the ghost&apos;s own author, which keeps the numbers meaningful
          rather than a measure of how many scripts have hit the file.
        </p>

        <h2>TAS</h2>
        <p>
          A ghost marked TAS was produced with tool assistance, rather than played in one sitting by hand. They
          are not comparable, so tool-assisted entries carry a small computer icon in every listing.
          Mark your uploads honestly.
        </p>

        <h2>MDP</h2>
        <p>
          The Most Download Player is whoever currently has the highest total of counted downloads
          added up across all of their ghosts. Not the most uploads, not the single most popular
          ghost, the sum. Their name shimmers wherever it appears on the site. It is calculated from
          live figures, so it moves to whoever is on top at that moment. Standings are on the{' '}
          <Link to="/community">Community</Link> page.
        </p>

        <h2>Reporting problems</h2>
        <p>
          This is a community project. If a ghost is mislabelled, misattributed or should not be here,
          raise it with the people who run the archive rather than expecting an automated system to
          catch it.
        </p>
      </div>
    </div>
  )
}
