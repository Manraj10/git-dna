# git-dna

Reads a repository's commit history and tells you what kind of committer lives there.

```bash
npx git-dna
```

![git-dna card for expressjs/express](./examples/express.svg)

Run it in any git repository. It reads `git log` and prints:

- an archetype (Night Owl, Deadline Crammer, Rage Committer, and 15 more) with the number that earned it and a one-line roast
- commits by hour and by weekday, in the author's own timezone
- longest daily streak, biggest commit, shortest commit message, most common first word
- your latest late-night commit and the message you repeat most
- language mix by lines changed, share of fix commits, reverts
- a one-line summary you can paste into a comment or a post

It also writes `git-dna.svg`, a 1200×630 card for your README, and `git-dna.png`, the same card for posting, since LinkedIn and X won't take an SVG. The PNG opens on its own and lands on your clipboard, so you can paste it straight into a post. Making the PNG borrows Chrome, Edge or Brave if one is installed, running it headless on a throwaway profile; without one you still get the SVG. The helix at the bottom is drawn from the repo's commit clock, so cards from different repos look different.

Nothing leaves your machine. There are no dependencies and no network calls. Node 18 or newer and git are all it needs.

## Examples

| junegunn/fzf | sindresorhus/is |
|---|---|
| ![fzf](./examples/fzf.svg) | ![is](./examples/sindresorhus-is.svg) |

## Usage

```bash
git-dna                          # current repository
git-dna ../some-repo             # another repository
git-dna --me                     # only commits matching your git config user.email
git-dna --author "Ada Lovelace"  # only commits whose author name or email contains this text
git-dna --since 2025-01-01       # a year in review
git-dna --json                   # raw numbers, for scripts
git-dna --no-card                # terminal report only
git-dna --no-png                 # SVG card only
git-dna --no-open                # don't pop the PNG open or copy it
git-dna --out card.svg           # write the card somewhere else
```

To show your card on your profile, commit it and reference it:

```md
![git-dna](./git-dna.svg)
```

## Archetypes

Each archetype has a threshold. The one the repo clears by the widest margin wins, and the next two are listed as traits. An archetype can win from 80% of its threshold if nothing else is closer. If nothing gets that far you get The Steady Hand. Under 10 commits you get The Hatchling, since there is not enough history to say anything.

| Archetype | Threshold |
|---|---|
| Night Owl | 15% of commits between midnight and 5am |
| Dawn Patrol | 12% of commits between 5am and 8am |
| Weekend Warrior | 25% of commits on Saturday or Sunday |
| Firefighter | 30% of messages mention a fix or bug |
| Friday Deployer | 10% of commits after 4pm on a Friday |
| Monolith Mover | 350 lines changed per commit on average |
| Surgeon | 18 lines or fewer per commit on average, with 30+ commits |
| Novelist | messages average 60+ characters |
| Silent Committer | 20% of messages are a single word |
| Streak Machine | a 21-day streak |
| 9-to-5 Professional | 90% of commits on weekdays between 9am and 6pm |
| Emoji Enthusiast | 12% of messages have an emoji, with 20+ commits |
| Conventionalist | 60% of messages start with feat:, fix: and friends, with 20+ commits |
| Committee | 12+ authors and nobody owns more than 60% of commits |
| Comeback Kid | went quiet for 90 days, with 5+ commits before and after |
| Deadline Crammer | 50% of commits on the 2 busiest days, with 10+ active days over at least 2 weeks |
| Rage Committer | 4% of messages swear, at least 3 times |
| One-File Wonder | 60% of commits touch the same file (lockfiles and READMEs don't count), with 20+ commits |

Run `npm test` to check every archetype against small generated repos.

Merge commits are skipped. In a shallow clone only the fetched history is counted.

## Contributing

Ideas for new archetypes, better thresholds, or sharper one-liners are welcome as issues or pull requests.

## License

MIT
