---
version: 1
extends: base
name: Blog
description: A place to write and publish articles online. Think of it like a simple magazine or diary that lives on the internet. 
suitable_for: With an admin panel where you can write posts, upload images and manage your blog in general. Good if you want to share stories, news, tutorials, or updates regularly. Works well for writers, journalists, hobby bloggers, or small media projects.
icon: "📝"
category: content
setup_goal: Seeding works, dev server starts without issues and open the page, there should be no errors in the console
---

## Setup
- Turn this starter into a blog. Remove Restate, and other non essential functionnalities. Auth is necessary
- Create the database structure for the blog. Include common tables such as posts, comments (if requested), tags (for posts)
- Make the UI for the blog posts in the web app, mimick the structure and layouts of Ghost or Medium blogs
- Include a draft mode for the articles

## Rendering markdown for the posts
- Use shadcn typeset: https://ui.shadcn.com/docs/typeset for the styles
- For rendering the markdown post, use `react-markdown` https://github.com/remarkjs/react-markdown#use

## Admin
- Change the dashboard to show blog statistics instead of what's in there
- In the dashboard home, add a "Quick Post" section, with a minimal markdown editor to help post quickly. Add a "Expand" button which takes to the create post page with the content prefilled (save the content in local storage to get it back easily). Use https://uiwjs.github.io/react-md-editor/
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
