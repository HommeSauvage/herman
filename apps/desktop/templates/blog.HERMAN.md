---
version: 1
extends: base
name: Blog
description: A fast blog you can write posts in.
extended_description: A content-focused blog with posts, drafts, tags, and an admin dashboard. Includes a markdown editor with preview, post versioning, and optional comments.
icon: "📝"
category: content
---

## Setup
- Turn this starter into a blog. Remove Restate, and other non essential functionnalities. Auth is necessary
- Create the database structure for the blog. Include common tables such as posts, comments (if requested), tags (for posts)
- Make the UI for the blog posts in the web app, mimick the structure and layouts of Ghost or Medium blogs
- Include a draft mode for the articles

## Admin
- Change the dashboard to show blog statistics instead of what's in there
- In the dashboard home, add a "Quick Post" section, with a minimal markdown editor to help post quickly. Add a "Expand" button which takes to the create post page with the content prefilled (save the content in local storage to get it back easily)
- In the full fledged UI, the editor should be a markdown editor with preview on the right (spliut the screen in half).
- Add versions for the blog post with who edited the post and timestamp.
- For tags, allow the admin to search by typing in an input (use shadcn and search the registries to load the combination of components to allow for the search of tags and creating new ones, you can do this with react-select as well).

## Questions
- Ask the user roughly what they'll write about (topics, niche, audience)
- Ask them whether they want to have comments enabled or not (this will help you decide to create the comments table or not)
- Ask them about the homepage: titles only minimaist or show previews (in case of previews, you may have to save the preview texts in a new field and make sure to not load the full content for the home page)
- Numbered pagination or auto load as we scroll down?

## Guidance
This is a blog project. Prefer simple content models, clear reading experiences,
and avoid introducing unnecessary infrastructure.
