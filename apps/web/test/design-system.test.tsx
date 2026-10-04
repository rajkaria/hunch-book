import { Outcome, Phase } from "@hunch-book/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { trapTab } from "../src/components/layout/MobileNav";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../src/components/states";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ChanceBar,
  Field,
  fieldA11y,
  InlineHelp,
  Input,
  PhasePill,
  Progress,
  phaseStyle,
  SegmentedControl,
  Stat,
  Tabs,
} from "../src/components/ui";

// The design system's primitives: what they render, what they tell assistive tech, and how the
// interactive ones respond to the keyboard.

describe("buttons", () => {
  it("default to type=button and block clicks while loading", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Stake</Button>);
    const button = screen.getByRole("button", { name: "Stake" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} loading variant="primary">
        Stake
      </Button>,
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The label stays while the spinner shows, so the accessible name does not change.
    expect(screen.getByRole("button", { name: "Stake" })).toBe(button);
  });

  it("link to pages in the app, and open other sites in a new tab", () => {
    render(
      <>
        <ButtonLink href="/markets" variant="primary" arrow>
          Browse markets
        </ButtonLink>
        <ButtonLink href="https://github.com/rajkaria/hunch-book" external arrow>
          Source
        </ButtonLink>
      </>,
    );
    const inside = screen.getByRole("link", { name: "Browse markets" });
    expect(inside.getAttribute("href")).toBe("/markets");
    expect(inside.getAttribute("target")).toBeNull();
    const outside = screen.getByRole("link", { name: "Source" });
    expect(outside.getAttribute("target")).toBe("_blank");
    expect(outside.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("pills", () => {
  it("give each phase its own label and colour", () => {
    expect(phaseStyle(Phase.Pool)).toEqual({ label: "Pool", tone: "cyan", live: true });
    expect(phaseStyle(Phase.PoolLocked).label).toBe("Pool locked");
    expect(phaseStyle(Phase.Graduated)).toEqual({ label: "Live book", tone: "accent", live: true });
    expect(phaseStyle(Phase.Closed).tone).toBe("warn");
    expect(phaseStyle(Phase.Settled, Outcome.Yes)).toEqual({
      label: "Settled YES",
      tone: "yes",
      live: false,
    });
    expect(phaseStyle(Phase.Settled, Outcome.No)).toEqual({ label: "Settled NO", tone: "no", live: false });
    expect(phaseStyle(Phase.Voided).label).toBe("Voided");
  });

  it("render the label as text, with decorative dots hidden", () => {
    const { container } = render(
      <>
        <PhasePill phase={Phase.Graduated} />
        <Badge tone="warn" dot>
          Seeded by Hunch Book
        </Badge>
      </>,
    );
    expect(screen.getByText("Live book")).toBeTruthy();
    expect(screen.getByText("Seeded by Hunch Book")).toBeTruthy();
    for (const dot of container.querySelectorAll("span[aria-hidden='true']"))
      expect(dot.textContent).toBe("");
  });
});

describe("figures", () => {
  it("describe the YES/NO split, and write the two shares when asked", () => {
    const { container } = render(<ChanceBar bps={6_250n} showLabels />);
    expect(screen.getByRole("img", { name: "YES 62.5%" })).toBeTruthy();
    expect(container.textContent).toContain("YES 62.5%");
    expect(container.textContent).toContain("NO 37.5%");
  });

  it("draw only the sides that have a share, and nothing without a chance", () => {
    const { container, rerender } = render(<ChanceBar bps={10_000n} />);
    expect(container.querySelectorAll("[role=img] > span")).toHaveLength(1);
    rerender(<ChanceBar bps={0n} />);
    expect(container.querySelectorAll("[role=img] > span")).toHaveLength(1);
    rerender(<ChanceBar bps={null} />);
    expect(container.querySelectorAll("[role=img] > span")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "No chance to show yet" })).toBeTruthy();
  });

  it("report progress as a clamped percentage", () => {
    render(<Progress ratio={1.4} met label="Pool size" />);
    expect(screen.getByRole("progressbar", { name: "Pool size" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("show a stat with a link to where its number comes from", () => {
    render(
      <Stat
        label="Markets created"
        value="12"
        hint="3 open now"
        source={{ href: "https://explorer/address/0xf1", label: "factory.marketCount", external: true }}
      />,
    );
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3 open now")).toBeTruthy();
    const source = screen.getByRole("link", { name: "factory.marketCount" });
    expect(source.getAttribute("href")).toBe("https://explorer/address/0xf1");
    expect(source.getAttribute("target")).toBe("_blank");
  });

  it("wrap content in a card that can be a list item", () => {
    render(
      <ul>
        <Card as="li" variant="glass" aria-label="A card">
          Inside
        </Card>
      </ul>,
    );
    expect(screen.getByRole("listitem", { name: "A card" }).textContent).toBe("Inside");
  });
});

describe("form fields", () => {
  it("tie the label, hint and error to the control", () => {
    render(
      <Field id="amount" label="Amount" hint="At least 1 USDC." error="Enter an amount in USDC.">
        <Input {...fieldA11y("amount", { hint: true, error: true })} unit="USDC" mono />
      </Field>,
    );
    const input = screen.getByLabelText("Amount");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("amount-hint amount-error");
    expect(document.getElementById("amount-hint")?.textContent).toBe("At least 1 USDC.");
    expect(screen.getByRole("alert").textContent).toBe("Enter an amount in USDC.");
    expect(screen.getByText("USDC")).toBeTruthy();
  });

  it("leave out describedby and invalid when there is nothing to describe", () => {
    expect(fieldA11y("x")).toEqual({ id: "x" });
    expect(fieldA11y("x", { hint: true })).toEqual({ id: "x", "aria-describedby": "x-hint" });
  });

  it("offer help in place, closed until asked", () => {
    const { container } = render(<InlineHelp summary="What is a complete set?">1 YES and 1 NO.</InlineHelp>);
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("What is a complete set?")).toBeTruthy();
  });
});

describe("tabs", () => {
  const tabs = [
    { id: "stake", label: "Stake", content: <p>Stake panel</p> },
    { id: "trade", label: "Trade", content: <p>Trade panel</p> },
    { id: "soon", label: "Soon", content: <p>Soon panel</p>, disabled: true },
    { id: "rules", label: "Rules", content: <p>Rules panel</p> },
  ];

  it("show one panel, labelled by its tab, with one tab stop", () => {
    render(<Tabs tabs={tabs} label="Ticket" />);
    const list = screen.getByRole("tablist", { name: "Ticket" });
    const all = within(list).getAllByRole("tab");
    expect(all.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toBe("Stake panel");
    expect(panel.getAttribute("aria-labelledby")).toBe(all[0]?.id);
  });

  it("move with the arrow keys, Home and End, skipping disabled tabs", () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} label="Ticket" onChange={onChange} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Trade" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Trade" }));
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Rules" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Stake" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Rules panel");
    fireEvent.keyDown(list, { key: "Home" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Stake panel");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["trade", "rules", "stake", "rules", "stake"]);
  });

  it("can be controlled", () => {
    function Controlled() {
      const [tab, setTab] = useState("trade");
      return (
        <>
          <Tabs tabs={tabs} label="Ticket" value={tab} onChange={setTab} />
          <p data-testid="tab">{tab}</p>
        </>
      );
    }
    render(<Controlled />);
    expect(screen.getByRole("tabpanel").textContent).toBe("Trade panel");
    fireEvent.click(screen.getByRole("tab", { name: "Rules" }));
    expect(screen.getByTestId("tab").textContent).toBe("rules");
  });
});

describe("segmented control", () => {
  function Side() {
    const [side, setSide] = useState<"yes" | "no">("yes");
    return (
      <SegmentedControl
        label="Side"
        value={side}
        onChange={setSide}
        options={[
          { value: "yes", label: "YES", detail: "0.62", tone: "yes" },
          { value: "no", label: "NO", detail: "0.38", tone: "no" },
        ]}
      />
    );
  }

  it("is a named group of native radio buttons", () => {
    render(<Side />);
    expect(screen.getByRole("group", { name: "Side" })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it("changes the choice when a segment is picked", () => {
    render(<Side />);
    fireEvent.click(screen.getByLabelText(/NO/));
    expect((screen.getByRole("radio", { name: /NO/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /YES/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("states", () => {
  it("say what is missing and what comes next", () => {
    render(
      <>
        <NotDeployed willShow={["Every market from the factory."]} />
        <EmptyState label="404" title="Nothing here" titleAs="h1" glyph="search">
          <p>Check the address.</p>
        </EmptyState>
      </>,
    );
    expect(screen.getByRole("region", { name: "Contracts not deployed on Monad testnet yet" })).toBeTruthy();
    expect(screen.getByText("Every market from the factory.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Nothing here" })).toBeTruthy();
  });

  it("report errors as an alert with a retry", () => {
    const retry = vi.fn();
    render(<ErrorState onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("Your funds are not affected.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });

  it("announce loading politely, with the skeletons hidden", () => {
    const { container } = render(<LoadingRows rows={2} label="Loading markets" />);
    expect(screen.getByRole("status").textContent).toBe("Loading markets");
    expect(container.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0);
  });
});

describe("focus trap", () => {
  it("wraps Tab and Shift+Tab inside the sheet", () => {
    render(
      <div data-testid="root">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>,
    );
    const root = screen.getByTestId("root");
    const [first, last] = screen.getAllByRole("button") as [HTMLElement, HTMLElement];
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    expect(trapTab(tab, root)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(
      trapTab(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }), root),
    ).toBe(true);
    expect(document.activeElement).toBe(last);
    first.focus();
    expect(trapTab(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }), root)).toBe(false);
    expect(trapTab(new KeyboardEvent("keydown", { key: "Enter" }), root)).toBe(false);
  });
});
