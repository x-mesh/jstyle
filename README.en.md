# jstyle

jstyle is a UI design skill for AI agents. It helps an agent set a design direction and check a real interface.

![An illustration of a wireframe, an effect preview, and a component card](assets/readme/jstyle-workflow.png)

The library has 25 card patterns and nine visual and entry effects. Select an effect, change its speed, and copy its standalone HTML.

![The jstyle pattern library with the light orbit effect](assets/readme/pattern-library.png)

## Get started

Place this folder where your agent can read it. Ask the agent to use `SKILL.md`:

```text
Read SKILL.md in this folder and improve the navigation and empty state of my dashboard.
```

To open the pattern library, run this command from the project root. The server needs Python 3.

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open the [pattern library](http://127.0.0.1:8765/assets/extended/index.html). Select an effect and press the play button. Open the code panel to copy the standalone HTML. Use search or a category filter to find a card pattern.

The examples use mock data. The page keeps edits in memory until you refresh it. The examples do not connect to authentication or server storage.

## Workflow

1. Record the user, task, content, brand, and device constraints.
2. Choose the main object and action. Set the layout and key states.
3. Build a representative screen. Check its text and actions in the browser.

The agent can compare design directions or review an existing screen without file changes. The [skill guide](SKILL.md) links to the relevant references.

## Tools

- [Comparison page generator](references/style-explorer.md): Compare design options on one page. It needs Python 3.10 or later.
- [Screenshot tool](references/tools.md): Capture screens and animation frames. It needs Node 22 or later and Chrome, Chromium, or Edge.
- [Image tools](references/media.md): Find and resize image assets.

The default workspace for drafts and screenshots is `.jstyle`. Put final code and assets in the target project.

## Check

Run these commands from the project root:

```bash
npm run check
npm run test:patterns
python3 -m unittest discover -s tests
```

The pattern browser test needs Node 22 or later and Chrome, Chromium, or Edge. The package name is `jstyle`. It is a private local package.

## License

The [MIT license](LICENSE) preserves the original copyright notice.
