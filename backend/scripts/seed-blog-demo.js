#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seeds 10 evergreen demo blog posts onto a tenant. Idempotent — re-runs
// skip slugs that already exist; no duplicates. Pass --reset to wipe the
// tenant's blog first (destructive).
//
// Usage on EC2:
//   cd /home/ubuntu/sitepresso/backend
//   node scripts/seed-blog-demo.js <business-slug>
//   node scripts/seed-blog-demo.js <business-slug> --reset

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const POSTS = [
  {
    slug: 'welcome-to-our-blog',
    title: 'Welcome to Our Blog',
    excerpt: 'A place to share updates, tips, and stories from our team.',
    tagsCsv: 'announcement, welcome',
    authorName: 'The Team',
    content: `Hello and welcome! This is the first post on our brand-new blog.

We'll be using this space to share product updates, behind-the-scenes stories, customer tips, and the occasional opinion on what we think makes a great experience for the people we serve.

## What you'll find here

Expect a mix of practical how-tos, news about what we're working on, and reflections on lessons we're learning along the way. We won't post on a fixed schedule — when there's something useful to share, we'll share it.

## Stay in the loop

If you'd like updates when we publish a new article, the easiest way is to bookmark this page or follow us on the channels linked at the bottom of the site.

Thanks for stopping by — and welcome aboard.`,
  },
  {
    slug: '5-tips-for-booking-your-first-appointment',
    title: '5 Tips for Booking Your First Appointment',
    excerpt: 'Make your first visit smooth and stress-free with these simple pointers.',
    tagsCsv: 'tips, appointments, first-visit',
    authorName: 'The Team',
    content: `Your first appointment with us shouldn't feel daunting. Here are five quick tips that take the friction out of the experience.

## 1. Pick a time that fits your day

Don't squeeze us in between meetings. Give yourself 15 minutes of buffer on either side so you arrive relaxed and leave without rushing.

## 2. Tell us anything we should know

If there's a specific concern, history, or preference, mention it in the booking notes. The more we know upfront, the better we can prepare.

## 3. Bring everything you need

A photo ID, any relevant paperwork, and (if relevant) the credit/debit card you'd like on file. A few seconds of prep saves five minutes at check-in.

## 4. Ask questions during the visit

There are no silly questions. If something isn't clear — pricing, process, what comes next — please ask. We'd rather over-explain than leave you guessing.

## 5. Save the confirmation email

It contains the meeting link (for virtual visits), the address (for in-person), and a one-click cancel/reschedule button if your plans change.

That's it. We can't wait to meet you.`,
  },
  {
    slug: 'what-to-expect-on-your-visit',
    title: 'What to Expect on Your Visit',
    excerpt: 'A quick walkthrough of how a typical appointment unfolds, from arrival to follow-up.',
    tagsCsv: 'process, expectations, guide',
    authorName: 'The Team',
    content: `If this is your first visit — or your tenth — here's a refresher on how we structure each appointment.

## Before you arrive

You'll get a confirmation email after booking and a friendly reminder the day before. If anything changes, you can reschedule with one click — no need to call.

## At check-in

Most visits start with a 2-3 minute check-in: a quick hello, confirmation of contact details, and any new notes you'd like us to know about.

## During the appointment

This is the bulk of your time with us. The exact flow depends on what you've booked, but we always:

- Listen to your concerns first
- Walk through what we'll do and why
- Pause for questions whenever you have them

## Wrap-up

We'll summarise what happened, what to expect afterwards, and any next steps. You'll get this in writing too — usually by email within the hour.

## Follow-up

For some visits we'll proactively check in a few days later. If something feels off, please don't wait for that email — reach out anytime.`,
  },
  {
    slug: 'why-online-booking-saves-you-time',
    title: 'Why Online Booking Saves You Time',
    excerpt: 'Skip the phone tag — book a slot when it suits you, day or night.',
    tagsCsv: 'online-booking, convenience, tips',
    authorName: 'The Team',
    content: `We get it — old habits die hard. For decades, booking an appointment meant calling during business hours, waiting on hold, and hoping the slot you wanted was still free.

Online booking changes the game. Here's why we recommend it.

## It's available when you are

10pm on a Sunday? Lunch break Monday? Doesn't matter. The booking page is always open. Pick a time, confirm, done.

## You can see real availability

No more "let me check… how about Thursday at 3?" The calendar shows you exactly which slots are open, in real time.

## Reschedules are one click

Plans change. With online booking, so does your appointment — no awkward phone call, no guilt. Just hit reschedule and pick a new slot.

## You always have a record

Every booking lands in your email and on your account. No more scribbled-down dates on Post-its.

We'll always take phone bookings for those who prefer them. But if you haven't tried online — give it a go next time. We think you'll be a convert by visit two.`,
  },
  {
    slug: 'cancellation-policy-explained',
    title: 'Our Cancellation Policy, Explained',
    excerpt: 'Here is exactly what happens when you need to cancel — no hidden fees, no surprises.',
    tagsCsv: 'policy, cancellation, faq',
    authorName: 'The Team',
    content: `Life happens. Plans change. We get it — and our cancellation policy is designed around that reality.

## The short version

- **More than 24 hours before:** No charge. Just hit cancel.
- **Within 24 hours:** No charge for first-time cancellations. After that, a small fee applies.
- **No-shows:** A fee of [check your booking confirmation] applies.

## How to cancel

The fastest way is the one-click link in your confirmation email. If you've lost it, log in and cancel from your bookings list — or send us a message.

## When fees apply

We hold a slot specifically for you. When that slot goes unused with little notice, we usually can't fill it, which means a real impact on the team. The fee covers that gap; it's not a punishment.

## Special circumstances

Sick? Family emergency? Just let us know — we don't charge for those. We'd rather you stay home than push through a visit you'll regret.

Questions about your specific booking? Reply to your confirmation email. Real humans read every message.`,
  },
  {
    slug: 'meet-our-team',
    title: 'Meet the People Behind the Service',
    excerpt: 'A quick introduction to the team that takes care of you.',
    tagsCsv: 'team, about-us, people',
    authorName: 'The Team',
    content: `You've seen our names on the booking page. Here's a slightly fuller picture of the humans behind them.

## Why we do this

We started this practice because we believed the experience could be better — clearer, kinder, faster. Every detail you see (online booking, follow-up emails, transparent pricing) was a deliberate choice in that direction.

## What you can expect from us

- **Time:** We don't rush appointments. The slot you book is yours.
- **Honesty:** If we're not the right fit for what you need, we'll say so and try to point you somewhere better.
- **Continuity:** We try to keep you with the same team member visit-to-visit.

## Behind the scenes

A lot of the work happens between visits — coordinating, following up, prepping for the next person who walks through the door. You don't see it, but we want you to know we're not just here for the hour we book.

If you'd like to know more about any individual team member, their bios are on the booking page — click their photo to see what they've worked on and what they're passionate about.`,
  },
  {
    slug: 'holiday-schedule-and-hours',
    title: 'Holiday Schedule and Hours',
    excerpt: 'Reduced hours and closures for upcoming public holidays — bookmark this for reference.',
    tagsCsv: 'hours, holidays, announcement',
    authorName: 'The Team',
    content: `Heads up on a few schedule changes coming up. Bookmark this page or save it to your calendar.

## Standard hours

Our normal operating window is **9am – 6pm**, **Monday through Friday**. Saturday hours vary — check the booking page for the latest.

## Public holidays

We're closed on the following days:

- **New Year's Day**
- **Independence Day**
- **Major regional public holidays**
- **Christmas Day & Boxing Day**

The booking page reflects all of these — you won't accidentally book a closed day.

## End-of-year period

Between Christmas and New Year, we operate on reduced hours. Booking remains available online, but response times for messages may be slower than usual.

## Emergency closures

Weather, power outages, illness — we'll always email affected appointments and post a banner on the homepage. Please check before travelling on a stormy day.

If a holiday isn't listed and you're unsure, hit the contact form. We'll get back the same business day.`,
  },
  {
    slug: 'customer-stories-real-reviews',
    title: 'Customer Stories: A Few Real Reviews',
    excerpt: 'A handful of unedited quotes from people who have visited recently.',
    tagsCsv: 'reviews, customer-stories, testimonials',
    authorName: 'The Team',
    content: `We don't curate, edit, or pay for reviews. Here are a few that stuck with us recently — quoted exactly as they were sent.

## On a first visit

> "I'd been putting this off for months. Walked out wishing I'd booked a year ago. The whole thing felt designed for someone like me — anxious, time-poor, allergic to small talk."

— A.K., booked April

## On the booking experience

> "Best decision was making this online. I booked at 11pm on a Tuesday, got a confirmation immediately, and it was over before I'd processed how easy it was."

— M.R., booked March

## On follow-up

> "What surprised me was the email three days later. Not selling me anything — just checking I was OK. That's not standard. I told my whole street."

— S.D., booked February

## On honest pricing

> "I quoted what I thought it would cost. They quoted less. Then it ended up being even less because they didn't need the second session. I had to write a review just because that almost never happens."

— J.P., booked January

If you've visited recently and have feedback — good or bad — we read every reply to our follow-up emails. Tell us how we did.`,
  },
  {
    slug: 'how-to-prepare-for-your-appointment',
    title: 'How to Prepare for Your Appointment',
    excerpt: 'A short checklist that turns a 5-minute prep into a smoother visit.',
    tagsCsv: 'preparation, checklist, tips',
    authorName: 'The Team',
    content: `A few minutes of prep makes a real difference. Here's our short checklist.

## The night before

- ☑ Re-read the confirmation email — it has location, time, and any pre-visit notes
- ☑ Set a phone reminder for 30 minutes before you need to leave
- ☑ Charge your phone — for virtual visits, you'll need it; for in-person, the booking link is your check-in

## On the day

- ☑ Eat normally unless we've said otherwise
- ☑ Wear comfortable clothing if your visit involves any movement
- ☑ Bring your ID, any relevant paperwork, and a pen
- ☑ Arrive 5-10 minutes early — not earlier; the waiting area is usually small

## For virtual visits

- ☑ Test the meeting link 5 minutes early
- ☑ Pick a quiet spot with decent light
- ☑ Have a glass of water on hand — these can run longer than you expect

## What you don't need

- ❌ A list of every concern you've ever had — we'd rather hear the most important one first
- ❌ To dress up — come as you are
- ❌ To prep questions — we'll ask the right ones

If anything's unclear, reply to your confirmation email before your visit. We'd rather sort it ahead of time than at the door.`,
  },
  {
    slug: 'behind-the-scenes-a-day-in-the-life',
    title: 'Behind the Scenes: A Day in the Life',
    excerpt: 'What happens between the appointments — the unglamorous, important work that keeps things running.',
    tagsCsv: 'behind-the-scenes, story, team',
    authorName: 'The Team',
    content: `If you've only seen us during your appointment, you've seen maybe 30% of what we do. Here's the other 70%.

## 7:45 AM — Setup

The first 15 minutes of the day are entirely about preparation. Reviewing the day's bookings, checking notes, prepping rooms or tools, running any system updates. Nothing customer-facing — but if it's skipped, the whole day suffers.

## 8:00 AM — Pre-day huddle

Five minutes, standing up. Whose appointments are sensitive today? Who needs which room? Are there any flags from the team? It's tiny, but it's the thing that catches the issue before the customer notices it.

## 9:00 AM – 1:00 PM — Morning block

Back-to-back appointments. The 5-minute buffer between each one is real prep time, not a break. Notes get written, the next person's file gets pulled, the room gets reset.

## 1:00 PM — Lunch and admin

The hour we don't book. Lunch is half of it; the other half is paperwork, confirmation emails, and the emails-that-aren't-actually-emergencies-but-feel-urgent.

## 2:00 PM – 6:00 PM — Afternoon block

Same shape as the morning. By 4pm we've usually seen everyone we'll see today. The last two hours are typically wrap-ups — calling people back, finishing notes, sending follow-up info.

## 6:00 PM — Wrap

Tomorrow's confirmation email goes out. Tools and rooms reset. Lights off.

## What you don't see

Bookings going in 24/7 from the website. The dashboard pinging when someone reschedules. Reminder emails firing automatically. The whole back-end is designed so we can spend the day with you, not at a phone.

That's it. Not glamorous, but every step is there for a reason.`,
  },
];

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const reset = args.includes('--reset');

  if (!slug) {
    console.error('Usage: node scripts/seed-blog-demo.js <business-slug> [--reset]');
    process.exit(1);
  }

  const business = await prisma.business.findUnique({
    where: { slug: slug.toLowerCase() },
    select: { id: true, name: true, slug: true },
  });
  if (!business) {
    console.error(`Business "${slug}" not found.`);
    process.exit(1);
  }
  console.log(`Seeding ${POSTS.length} blog posts onto "${business.name}" (${business.slug})…`);

  if (reset) {
    const { count } = await prisma.blogPost.deleteMany({ where: { businessId: business.id } });
    console.log(`  ↺ Reset: deleted ${count} existing post(s)`);
  }

  let created = 0, skipped = 0, failed = 0;
  for (const p of POSTS) {
    try {
      const existing = await prisma.blogPost.findUnique({
        where: { businessId_slug: { businessId: business.id, slug: p.slug } },
      });
      if (existing) { skipped += 1; console.log(`  • skip ${p.slug} (already exists)`); continue; }
      await prisma.blogPost.create({
        data: {
          businessId: business.id,
          slug: p.slug,
          title: p.title,
          excerpt: p.excerpt,
          content: p.content,
          tagsCsv: p.tagsCsv,
          authorName: p.authorName,
          isPublished: true,
          publishedAt: new Date(),
        },
      });
      created += 1;
      console.log(`  ✓ ${p.slug}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${p.slug} — ${err.message}`);
    }
  }
  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
