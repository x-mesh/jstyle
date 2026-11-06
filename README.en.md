# jstyle

[한국어](README.md)

jstyle is a UI design skill for AI agents. It helps an agent set a design direction and check a real interface.

![An illustration of a wireframe, an effect preview, and a component card](assets/readme/jstyle-workflow.png)

The pattern library has nine visual and entry effects, 25 card patterns, 14 landing studies, and 12 product UI studies. Select an effect, change its speed, and copy its standalone HTML.

![The jstyle pattern library with the light orbit effect](assets/readme/pattern-library.png)

## Install

Install Node.js and `npx`. Run this command in your project folder:

```bash
npx skills add x-mesh/jstyle
```

Select the agents that will use the skill. To install only for Codex, run:

```bash
npx skills add x-mesh/jstyle --agent codex --skill jstyle
```

To install for all projects, add `-g`:

```bash
npx skills add x-mesh/jstyle -g
```

To install from a local copy, run `npx skills add .` in that folder.

### Use the command

The comparison page generator, the screenshot tool, and the image tools are also available as the `jstyle` command. The command needs Node 22 or later.

```bash
npm i -g github:x-mesh/jstyle
jstyle doctor
```

`jstyle doctor` checks Node, the browser, and the location of the command. Run `jstyle --help` to see all commands.
If you do not install the command, run `node bin/jstyle.mjs <command>` in the skill folder.

## Get started

After installation, ask the agent to use jstyle:

```text
Use jstyle to improve the navigation and empty state of my dashboard.
```

Download this repository to open the pattern library. Run this command from its root folder. The command needs Node 22 or later.

```bash
node bin/jstyle.mjs library
```

The pattern library opens in the browser. If it does not open, open the address in the terminal output. Select an effect and press the play button. Open the code panel to copy the standalone HTML. Use search or a category filter to find a card pattern.

The landing and product UI studies rebuild tokens and screen patterns from public pages and product screens. All person and team names are mock data. The library pages are in Korean.

![The product UI study with a member profile sheet](assets/readme/product-ui-study.png)

Use the component kit for dense business screens, such as lists, tables, settings, and approvals. Add `kit.css` and `kit.js` to a page. No build step is necessary. To open the kit documentation, run:

```bash
node bin/jstyle.mjs kit
```

![The first page of the jstyle kit documentation with color tokens](assets/readme/component-kit.png)

The examples use mock data. The page keeps edits in memory until you refresh it. The examples do not connect to authentication or server storage.

## Compare design drafts

If you cannot choose a direction, ask the agent for several drafts on one comparison page:

```text
Use jstyle to make three drafts of the first screen of the order dashboard. Show them on a comparison page.
```

The agent first describes each direction in text. If you want to see the screens, it makes one HTML first screen for each draft and puts them on one comparison page. If you do not give a number, it makes three drafts.

The comparison page shows the drafts side by side or one at a time at full size. The default screen sizes are 1280×900 for desktop and 390×844 for mobile.
Press **Select** on the draft that you prefer. The page copies a sentence such as `Round 01: Go with 02 Name`. Send this sentence and your comments to the agent. The agent continues with the selected draft.

![A comparison page with three drafts of an order dashboard side by side](assets/readme/style-explorer.en.png)

If you already have drafts, make the comparison page yourself:

```bash
jstyle explore ./designs
```

Each HTML file in the folder becomes one draft. The name comes from the HTML `<title>` or from the file name. The result is `style-explorer.html` in the folder. If you run the command in a terminal, it starts a local server and opens the page in the browser. To make the page again after you change a draft, add `--force`.

- Open the page on a phone or another computer: add `--host 0.0.0.0`, then open the `Other devices` address in the terminal output. Other people in the same network can also open this address.
- Compare with the current screen: in `manifest.json`, add the current screen with `"baseline": true`. It becomes the first item. A page from a running development server can use `"kind": "url"`, but other devices cannot show it.
- Start the next round: to compare refined drafts, make a new round folder such as `explore/02/` and set `round` to `"02"`. Keep the previous round as it is.

The manifest fields are in the [comparison page reference](references/style-explorer.md) and in `jstyle explore --help-build`.

## Workflow

1. Record the user, task, content, brand, and device constraints.
2. Choose the main object and action. Set the layout and key states.
3. Build a representative screen. Check its text and actions in the browser.

The agent can [compare design directions on one page](#compare-design-drafts) or review an existing screen without file changes. The [skill guide](SKILL.md) links to the relevant references.

## Tools

- [Comparison page generator](references/style-explorer.md): Compare design options on one page. It needs Node 22 or later.
- [Screenshot tool](references/tools.md): Capture screens and animation frames. It needs Node 22 or later and Chrome, Chromium, or Edge.
- [Image tools](references/media.md): Find and resize image assets.

The default workspace for drafts and screenshots is `.jstyle`. Put final code and assets in the target project.

## Check

Run these commands from the project root:

```bash
npm run check
node --test "tests/test_*.mjs"
```

The pattern browser test needs Node 22 or later and Chrome, Chromium, or Edge. The package name is `jstyle`. The package is not on the npm registry. Install it from GitHub.

## License

The [MIT license](LICENSE) preserves the original copyright notice.
