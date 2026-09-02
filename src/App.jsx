import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { collection, collectionGroup, doc, documentId, getDoc, getDocs, limit, onSnapshot, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { ArrowLeft, ArrowRight, Check, CircleUserRound, Copy, LogOut, Moon, Pencil, Plus, Settings, ShoppingBasket, Sparkles, Sun, Trash2, Users, Utensils, X } from "lucide-react";
import { auth, db, firebaseReady, googleProvider } from "./firebase";
import { useT } from "./i18n";

/* ------------------------------------------------------------------ */
/* Data helpers — unchanged logic, same Firestore shape as before      */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* India date & time helpers                                          */
/* ------------------------------------------------------------------ */

const INDIA_TIME_ZONE = "Asia/Kolkata";

const getIndiaParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const value = (type) =>
    parts.find((part) => part.type === type)?.value || "";

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
};

const getIndiaDateKey = (date = new Date()) => {
  const { year, month, day } = getIndiaParts(date);
  return `${year}-${month}-${day}`;
};

const monthKey = () => getIndiaDateKey().slice(0, 7);

const dateKey = (day) => {
  const { year, month } = getIndiaParts();
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
};

const todayDay = () => Number(getIndiaParts().day);

const monthDays = () => {
  const { year, month } = getIndiaParts();
  return new Date(Number(year), Number(month), 0).getDate();
};

const monthLabel = () =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: INDIA_TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(new Date());

const weekdayLabel = (day) => {
  const { year, month } = getIndiaParts();

  return new Intl.DateTimeFormat(undefined, {
    timeZone: INDIA_TIME_ZONE,
    weekday: "long",
  }).format(new Date(Number(year), Number(month) - 1, day));
};

const createId = () => crypto.randomUUID();
const inviteCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const guestTypes = [{ key: "veg", code: "1V", emoji: "🥬" }, { key: "egg", code: "1E", emoji: "🥚" }, { key: "fish", code: "1F", emoji: "🐟" }, { key: "meat", code: "1M", emoji: "🍖" }];
const guestTypeFor = (record) => guestTypes.find((x) => x.key === record?.foodType || x.code === record?.mealCode)?.key || "veg";
const guestQuantities = (record) => {
  const totals = Object.fromEntries(guestTypes.map((type) => [type.key, 0]));
  if (!record || record.status !== "guest") return totals;
  if (record.quantities && typeof record.quantities === "object") {
    guestTypes.forEach((type) => { totals[type.key] = Math.max(0, Number(record.quantities[type.key] || 0)); });
    return totals;
  }
  // Backward compatibility with the old one-record = one-meal format.
  totals[guestTypeFor(record)] = Math.max(1, Number(record.quantity || 1));
  return totals;
};
const guestRecordTotal = (record) => Object.values(guestQuantities(record)).reduce((a, b) => a + b, 0);
const badgeMap = (personId, records) => {
  const active = Object.values(records || {}).filter((record) => record.memberId === personId && record.status === "on").sort((a, b) => a.date.localeCompare(b.date) || (a.session === "morning" ? -1 : 1));
  return Object.fromEntries(active.map((record, index) => [`${record.date}_${record.session}`, index + 1]));
};
const boarderTotal = (personId, records) => Object.values(records || {}).filter((record) => record.memberId === personId && record.status === "on").length;
const guestTotals = (personId, records) => {
  const totals = Object.fromEntries(guestTypes.map((type) => [type.key, 0]));
  Object.values(records || {}).filter((record) => record.memberId === personId && record.status === "guest").forEach((record) => {
    const quantities = guestQuantities(record);
    guestTypes.forEach((type) => { totals[type.key] += quantities[type.key]; });
  });
  return totals;
};
const guestTotalSum = (totals) => Object.values(totals).reduce((a, b) => a + b, 0);


function useIndiaClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    let offset = 0;

    const syncIndiaTime = async () => {
      try {
        const response = await fetch(
          "https://timeapi.io/api/time/current/zone?timeZone=Asia%2FKolkata"
        );

        if (!response.ok) throw new Error("India time unavailable");

        const data = await response.json();

        const remoteDate = new Date(
          `${data.date}T${data.time}${data.milliSeconds !== undefined
            ? `.${String(data.milliSeconds).padStart(3, "0")}`
            : ""
          }+05:30`
        );

        if (!Number.isNaN(remoteDate.getTime())) {
          offset = remoteDate.getTime() - Date.now();

          if (active) {
            setNow(new Date(Date.now() + offset));
          }
        }
      } catch (error) {
        console.warn(
          "India network time unavailable, using Asia/Kolkata fallback.",
          error
        );
      }
    };

    // Page immediately render হবে। API-এর জন্য অপেক্ষা করবে না।
    syncIndiaTime();

    const timer = setInterval(() => {
      if (active) {
        setNow(new Date(Date.now() + offset));
      }
    }, 1000);

    // মাঝে মাঝে network time আবার sync করবে
    const resyncTimer = setInterval(syncIndiaTime, 5 * 60 * 1000);

    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(resyncTimer);
    };
  }, []);

  return now;
}

function BrandMark({ className = "" }) {
  return (
    <img
      className={`brand-mark ${className}`}
      src="/hari-vanga-logo.png"
      alt="Hari Vanga"
    />
  );
}
/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */
function Language({ lang, setLang, light = false }) { return <button className={`language ${light ? "light" : ""}`} onClick={() => setLang(lang === "bn" ? "en" : "bn")}>🌐 {lang === "bn" ? "বাংলা / EN" : "EN / বাংলা"}</button>; }
function Back({ onClick, label }) { return <button aria-label={label} className="back" onClick={onClick}><ArrowLeft size={18} /></button>; }
function Screen({ children }) { return <div className="screen"><i className="screen-blob a" /><i className="screen-blob b" /><span className="screen-doodle">🍋</span><div className="screen-inner">{children}</div></div>; }

/* ------------------------------------------------------------------ */
/* Landing                                                              */
/* ------------------------------------------------------------------ */
function Landing({ t, lang, setLang, go }) {
  const chats = lang === "bn"
    ? [["রাহুল", "কাল থেকে meal off 🙏"], ["সুমন", "দাদা আজ রাতে খাব না"], ["অরিজিৎ", "আমি ৭ দিন বাড়ি আছি"], ["গোপাল", "কাল সকালে ডিম ভাত রাখিস"]]
    : [["Rahul", "Meal off from tomorrow 🙏"], ["Suman", "Bro, I'm not eating tonight"], ["Arijit", "I'm home for 7 days"], ["Gopal", "Keep egg rice tomorrow"]];

  const pillars = lang === "bn"
    ? [
      ["🍚", "Boarder meal", "সকাল-রাত টগল করো, টোটাল নিজেই যোগ হবে"],
      ["🍛", "Guest meal", "Veg, Egg, Fish, Meat — সব হিসাব এক জায়গায়"],
      ["🧺", "বাজার খরচ", "কে কত টাকা দিল, কী কেনা হলো — সব লেখা থাকবে"]
    ]
    : [
      ["🍚", "Boarder meals", "Toggle morning & night — totals add themselves"],
      ["🍛", "Guest meals", "Veg, egg, fish, meat, all tracked in one place"],
      ["🧺", "Bazar spends", "Every rupee and every item, always on record"]
    ];

  return (
    <main className="landing">

      <section className="premium-hero">

        <div className="hero-glow one"></div>
        <div className="hero-glow two"></div>

        <Language lang={lang} setLang={setLang} light />

        <div className="hero-floating rice">🍚</div>
        <div className="hero-floating chilli">🌶️</div>
        <div className="hero-floating bowl">🍲</div>


        <div className="hero-content">

          <div className="eyebrow">
            <Sparkles size={15} />
            {t("badge")}
          </div>


          <h1>
            {t("brand")}
          </h1>


          <h2>
            {t("strap")}
          </h2>


          <p>
            {t("hero")}
          </p>


          <button className="premium-start" onClick={go}>
            {t("start")}
            <ArrowRight />
          </button>

        </div>


      </section>



      <section className="pillars premium-pillars">

        {pillars.map(([icon, title, desc]) => (
          <article key={title}>
            <span>{icon}</span>
            <b>{title}</b>
            <p>{desc}</p>
          </article>
        ))}

      </section>



      <section className="story">

        <h2>{t("nightmare")}</h2>

        <p>{t("familiar")}</p>


        <div className="chat-stack">
          {chats.map(([name, message], i) => (
            <div className={`chat ${i % 2 ? "right" : ""}`} key={name}>
              <b>{name}</b>
              <span>{message}</span>
              <small>11:5{i} PM ✓✓</small>
            </div>
          ))}
        </div>


        <div className="story-punch">
          {t("storyEnd")} 🫠
        </div>


      </section>



      <section className="final-cta">
        <span>🍲</span>
        <h2>{t("digital")}</h2>

        <button className="cta full-cta" onClick={go}>
          {t("start")}
          <ArrowRight />
        </button>

      </section>


    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Auth / mess creation flow                                          */
/* ------------------------------------------------------------------ */
function Auth({ t, user, login, logout, choose }) {
  return <Screen><div className="auth-card"><div className="pot">🍲</div><h2>{t("brand")}</h2>
    {user ? <><p>{t("signed")}: <b>{user.displayName}</b></p><button className="cta full" onClick={choose}>{t("continue")}<ArrowRight /></button><button className="text-btn" onClick={logout}>{t("logout")}</button></>
      : <><p>{t("signIn")} — {t("create")} / {t("join")}</p><button className="google" onClick={login}><CircleUserRound />{t("signIn")}</button></>}
  </div></Screen>;
}
function Choose({ t, setScreen }) {
  return <Screen><div className="auth-card"><Back label={t("back")} onClick={() => setScreen("auth")} /><div className="pot">🏠</div><h2>{t("brand")}</h2>
    <button className="cta full" onClick={() => setScreen("create")}>{t("create")}<ArrowRight /></button>
    <button className="secondary full" onClick={() => setScreen("join")}>{t("join")}<Users /></button>
  </div></Screen>;
}
function Create({ t, user, back, onDone }) {
  const [name, setName] = useState(""), [people, setPeople] = useState([user.displayName || "", "", ""]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const create = async () => {
    if (!name.trim() || busy) return; setBusy(true);
    try {
      const mess = doc(collection(db, "messes")), code = inviteCode(), founder = writeBatch(db);
      founder.set(mess, { name: name.trim(), inviteCode: code, createdBy: user.uid, currentManagerId: user.uid, managerName: user.displayName || "Manager", createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      founder.set(doc(mess, "members", user.uid), { uid: user.uid, linkedUserId: user.uid, displayName: user.displayName || "Manager", role: "manager", active: true, joinedAt: serverTimestamp() });
      founder.set(doc(db, "invites", code), { messId: mess.id, createdBy: user.uid, createdAt: serverTimestamp() });
      await founder.commit();
      const content = writeBatch(db);
      people.filter((p) => p.trim()).forEach((person) => content.set(doc(mess, "people", createId()), { name: person.trim(), active: true, createdAt: serverTimestamp() }));
      content.set(doc(mess, "months", monthKey()), { managerId: user.uid, minimumBoarderMeals: 40, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      content.set(doc(db, "users", user.uid), { activeMessId: mess.id, currentMessId: mess.id, role: "manager", updatedAt: serverTimestamp() }, { merge: true });
      await content.commit();
      onDone(mess.id, "setup");
    } catch (e) { console.error("createMess", e); setError(e.message); setBusy(false); }
  };
  return <Screen><div className="flow-card"><Back label={t("back")} onClick={back} /><span className="step">01 / 02</span><h2>{t("createTitle")}</h2>
    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
    <h3>{t("members")}</h3><p>{t("memberHint")}</p>
    {people.map((p, i) => <input key={i} value={p} onChange={(e) => setPeople((all) => all.map((x, n) => n === i ? e.target.value : x))} placeholder={t("personPlaceholder")} />)}
    <button className="text-btn add" onClick={() => setPeople([...people, ""])}><Plus />{t("add")}</button>
    {error && <p className="error">{error}</p>}
    <button className="cta full" disabled={!name.trim() || busy} onClick={create}>{busy ? t("loading") : t("continue")}<ArrowRight /></button>
  </div></Screen>;
}
function Join({ t, user, back, onDone }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const join = async () => {
    setBusy(true);
    setError("");

    try {
      const typedCode = code.trim().toUpperCase();

      const messId = await runTransaction(db, async (tx) => {

        const inviteRef = doc(db, "invites", typedCode);
        const invite = await tx.get(inviteRef);

        if (!invite.exists()) {
          throw new Error("invalid-code");
        }


        const foundMessId = invite.data().messId;

        if (!foundMessId) {
          throw new Error("invalid-code");
        }


        const membership = doc(
          db,
          "messes",
          foundMessId,
          "members",
          user.uid
        );


        const profile = doc(
          db,
          "users",
          user.uid
        );



        // user profile update
        tx.set(
          profile,
          {
            uid: user.uid,
            displayName: user.displayName || "Member",
            email: user.email || "",
            photoURL: user.photoURL || "",
            activeMessId: foundMessId,
            currentMessId: foundMessId,
            updatedAt: serverTimestamp()
          },
          {
            merge: true
          }
        );



        // always join as member
        tx.set(
          membership,
          {
            uid: user.uid,
            linkedUserId: user.uid,
            displayName: user.displayName || "Member",
            email: user.email || "",
            photoURL: user.photoURL || "",

            role: "member",

            active: true,

            joinedWithCode: typedCode,

            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          },
          {
            merge: true
          }
        );


        return foundMessId;

      });


      onDone(messId, "tracker");


    } catch (e) {

      console.error("joinMessFirestore", e);

      setError(
        e.message === "invalid-code"
          ? t("invalidCode")
          : `${t("error")} ${e.message || ""}`
      );

    } finally {

      setBusy(false);

    }
  };


  return (
    <Screen>

      <div className="auth-card">

        <Back
          label={t("back")}
          onClick={back}
        />

        <div className="pot">
          🧑‍🍳
        </div>


        <h2>
          {t("joinTitle")}
        </h2>


        <p>
          {t("joinHint")}
        </p>


        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="X7QP2A"
        />


        <button
          className="cta full"
          disabled={!code || busy}
          onClick={join}
        >

          {busy ? t("loading") : t("joinNow")}

          <ArrowRight />

        </button>


        {error &&
          <p className="error">
            {error}
          </p>
        }


      </div>

    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Live mess data                                                      */
/* ------------------------------------------------------------------ */
function useMess(messId) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!messId) { setState({ loading: false }); return undefined; }
    let alive = true; setState({ loading: true });
    const root = `messes/${messId}`, month = monthKey();
    const observe = (ref, key, map = false) => onSnapshot(ref, (snap) => {
      if (alive) setState((s) => ({ ...s, [key]: map ? Object.fromEntries(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])) : snap.data(), loading: false }));
    }, (error) => { console.error(`Firestore ${key}`, error); if (alive) setState((s) => ({ ...s, error: error.message, loading: false })); });
    const stops = [
      observe(doc(db, root), "mess"),
      observe(collection(db, root, "members"), "members", true),
      observe(collection(db, root, "people"), "people", true),
      observe(doc(db, root, "months", month), "month"),
      observe(collection(db, root, "months", month, "memberStatuses"), "statuses", true),
      observe(collection(db, root, "months", month, "mealRecords"), "records", true),
      observe(collection(db, root, "months", month, "guestMeals"), "legacyGuestMeals", true),
      observe(collection(db, root, "expenses"), "expenses", true),
      observe(collection(db, root, "notes"), "notes", true),
    ];
    return () => { alive = false; stops.forEach((stop) => stop()); };
  }, [messId]);
  return state;
}

function Setup({ t, messId, data, user, back, done }) {
  const [minimum, setMinimum] = useState(data.month?.minimumBoarderMeals ?? 40);
  const toggle = (id) => setDoc(doc(db, "messes", messId, "months", monthKey(), "memberStatuses", id), { type: data.statuses?.[id]?.type === "guest" ? "boarder" : "guest", updatedAt: serverTimestamp() }, { merge: true });
  const save = async () => {
    const batch = writeBatch(db), root = doc(db, "messes", messId, "months", monthKey());
    batch.set(root, { minimumBoarderMeals: Number(minimum), managerId: user.uid, updatedAt: serverTimestamp() }, { merge: true });
    Object.values(data.people || {}).forEach((person) => batch.set(doc(root, "memberStatuses", person.id), { type: data.statuses?.[person.id]?.type || "boarder", updatedAt: serverTimestamp() }, { merge: true }));
    await batch.commit(); done();
  };
  return <Screen><div className="flow-card"><Back label={t("back")} onClick={back} /><span className="step">02 / 02</span><h2>{t("monthSetup")}</h2>
    <div className="minimum"><label>{t("min")}</label><input type="number" value={minimum} onChange={(e) => setMinimum(e.target.value)} /><span>{t("mealsMonth")}</span></div>
    <div className="member-choices">{Object.values(data.people || {}).map((person) => { const type = data.statuses?.[person.id]?.type || "boarder"; return <button key={person.id} className={type} onClick={() => toggle(person.id)}><b>{person.name}</b><span>{type === "guest" ? `🍛 ${t("guest")}` : `🏠 ${t("boarder")}`}</span></button>; })}</div>
    <button className="cta full" onClick={save}>{t("tracker")}<ArrowRight /></button>
  </div></Screen>;
}

/* ------------------------------------------------------------------ */
/* Meal controls                                                       */
/* ------------------------------------------------------------------ */
function GuestMealControl({ record, editable, onChange }) {
  const [open, setOpen] = useState(false);

  const quantities = guestQuantities(record);
  const total = guestTotalSum(quantities);

  const update = (foodKey, delta) => {
    const next = {
      ...quantities,
      [foodKey]: Math.max(0, quantities[foodKey] + delta)
    };

    const nextTotal = guestTotalSum(next);

    const firstActive = guestTypes.find(
      (food) => next[food.key] > 0
    );

    onChange({
      status: nextTotal > 0 ? "guest" : "off",
      quantities: next,
      foodType: firstActive?.key || null,
      mealCode: firstActive?.code || null,
    });
  };

  const closePicker = () => {
    setOpen(false);
  };

  /*
    Lock the background while the mobile guest picker
    is open. The modal itself lives directly under body
    through a React portal, so the swipe layer cannot
    move or clip it.
  */
  useEffect(() => {
    if (!open || window.innerWidth > 900) return undefined;

    const previousOverflow = document.body.style.overflow;
    const previousTouchAction = document.body.style.touchAction;

    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.touchAction = previousTouchAction;
    };
  }, [open]);

  const mobilePicker =
    open && typeof document !== "undefined"
      ? createPortal(
        <div
          className="mobile-guest-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Guest meal quantities"
          onClick={closePicker}
        >
          <div
            className="guest-stepper mobile-guest-modal"
            onClick={(e) => e.stopPropagation()}
          >

            <div className="picker-title">
              <div>
                <span className="guest-modal-kicker">
                  🍛 Guest meal
                </span>

                <strong>
                  Add your meals
                </strong>
              </div>

              <button
                type="button"
                className="picker-close"
                onClick={closePicker}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </div>

            <div className="guest-modal-subtitle">
              Choose the food type and quantity
            </div>

            <div className="guest-food-list">
              {guestTypes.map((food) => (
                <div
                  className={`food-step ${quantities[food.key] > 0
                      ? "has-quantity"
                      : ""
                    }`}
                  key={food.key}
                >

                  <div className="food-label">

                    <span className="food-emoji">
                      {food.emoji}
                    </span>

                    <div>
                      <b>
                        {food.key}
                      </b>

                      <small>
                        {quantities[food.key] > 0
                          ? `${quantities[food.key]} meal${quantities[food.key] > 1
                            ? "s"
                            : ""
                          }`
                          : "Not added"}
                      </small>
                    </div>

                  </div>

                  <div className="quantity-stepper">

                    <button
                      type="button"
                      onClick={() =>
                        update(food.key, -1)
                      }
                      disabled={!quantities[food.key]}
                      aria-label={`Remove ${food.key}`}
                    >
                      −
                    </button>

                    <strong>
                      {quantities[food.key]}
                    </strong>

                    <button
                      type="button"
                      onClick={() =>
                        update(food.key, 1)
                      }
                      aria-label={`Add ${food.key}`}
                    >
                      +
                    </button>

                  </div>

                </div>
              ))}
            </div>

            <div className="guest-modal-total">

              <div>
                <span>
                  Total guest meals
                </span>

                <strong>
                  {total}
                </strong>
              </div>

              <span className="guest-total-icons">
                {guestTypes
                  .filter(
                    (food) =>
                      quantities[food.key]
                  )
                  .map(
                    (food) => food.emoji
                  )
                  .join(" ")}
              </span>

            </div>

            <button
              type="button"
              className="done-choice"
              onClick={closePicker}
            >
              Done
              <Check size={17} />
            </button>

          </div>
        </div>,
        document.body
      )
      : null;

  return (
    <>
      <div
        className={`guest-control ${open ? "open" : ""
          }`}
      >

        <button
          disabled={!editable}
          className={`meal guest-main ${total
              ? "guest-on"
              : "guest-off"
            }`}
          onClick={() =>
            editable && setOpen(true)
          }
        >

          {total ? (
            <>
              <span className="guest-main-icons">
                {guestTypes
                  .filter(
                    (food) =>
                      quantities[food.key]
                  )
                  .map(
                    (food) =>
                      food.emoji
                  )
                  .join("")}
              </span>

              <b>
                {total}
              </b>
            </>
          ) : (
            <>
              <Plus size={18} />
              <span>
                Guest
              </span>
            </>
          )}

        </button>

      </div>

      {/* -----------------------------------------------------------
          Desktop picker
          ----------------------------------------------------------- */}

      {open && (
        <div className="desktop-guest-picker">

          <div className="food-picker guest-stepper">

            <div className="picker-title">
              Guest meals

              <button
                type="button"
                className="picker-close"
                onClick={closePicker}
              >
                <X size={15} />
              </button>
            </div>

            {guestTypes.map((food) => (
              <div
                className="food-step"
                key={food.key}
              >

                <span className="food-label">
                  {food.emoji}
                  <b>
                    {food.key}
                  </b>
                </span>

                <div className="quantity-stepper">

                  <button
                    type="button"
                    onClick={() =>
                      update(food.key, -1)
                    }
                    disabled={
                      !quantities[food.key]
                    }
                  >
                    −
                  </button>

                  <strong>
                    {quantities[food.key]}
                  </strong>

                  <button
                    type="button"
                    onClick={() =>
                      update(food.key, 1)
                    }
                  >
                    +
                  </button>

                </div>

              </div>
            ))}

            <button
              type="button"
              className="done-choice"
              onClick={closePicker}
            >
              Done
            </button>

          </div>

        </div>
      )}

      {/* -----------------------------------------------------------
          Mobile picker lives OUTSIDE swipe-tab-content
          ----------------------------------------------------------- */}

      {mobilePicker}

    </>
  );
}
function BoarderMealControl({ record, sequence, editable, onChange, session }) {
  const on = record?.status === "on", Icon = session === "morning" ? Sun : Moon;
  return <button disabled={!editable} className={`meal onoff ${on ? session : ""}`} onClick={() => onChange({ status: on ? "off" : "on", mealCode: null, foodType: null })}><Icon size={17} fill={on ? "currentColor" : "none"} />{on && <small>{sequence}</small>}</button>;
}

/* ------------------------------------------------------------------ */
/* Desktop tracker — one row per person, dates as columns, total at end */
/* ------------------------------------------------------------------ */
function TrackerCell({ person, day, kind, records, editable, change }) {
  const date = dateKey(day), morning = records?.[`${person.id}_${date}_morning`], night = records?.[`${person.id}_${date}_night`], sequence = kind === "boarder" ? badgeMap(person.id, records) : {};
  return <div className="clean-cell">
    {kind === "boarder"
      ? <><BoarderMealControl session="morning" record={morning} sequence={sequence[`${date}_morning`]} editable={editable} onChange={(patch) => change(person, day, "morning", patch)} /><BoarderMealControl session="night" record={night} sequence={sequence[`${date}_night`]} editable={editable} onChange={(patch) => change(person, day, "night", patch)} /></>
      : <><GuestMealControl record={morning} editable={editable} onChange={(patch) => change(person, day, "morning", patch)} /><GuestMealControl record={night} editable={editable} onChange={(patch) => change(person, day, "night", patch)} /></>}
  </div>;
}
function TotalBadge({ kind, value, totals, t }) {
  if (kind === "guest") return <div className="total-plate guest"><b>{guestTotalSum(totals)}</b><small>{t("total")}</small><div className="plate-breakdown">{guestTypes.map((food) => <span key={food.key}>{food.emoji}{totals[food.key]}</span>)}</div></div>;
  return <div className="total-plate"><b>{value}</b><small>{t("total")}</small></div>;
}
function CleanDesktopSection({ title, kind, people, records, editable, change, t }) {
  const dates = Array.from({ length: monthDays() }, (_, index) => index + 1);
  return <section className={`clean-section ${kind}`}>
    <div className="clean-section-heading"><h2>{title}</h2><span>{people.length}</span></div>
    {people.length ? <div className="clean-table">
      <div className="clean-header"><b>{t("members")}</b>{dates.map((day) => <b key={day}>{day}</b>)}<b className="total-head">{t("total")}</b></div>
      {people.map((person) => {
        const total = kind === "boarder" ? boarderTotal(person.id, records) : null, totals = kind === "guest" ? guestTotals(person.id, records) : null;
        return <div className="clean-row" key={person.id}>
          <div className="clean-name"><b>{person.name}</b></div>
          {dates.map((day) => <TrackerCell key={day} person={person} day={day} kind={kind} records={records} editable={editable} change={change} />)}
          <div className="clean-total"><TotalBadge kind={kind} value={total} totals={totals} t={t} /></div>
        </div>;
      })}
    </div> : <div className="tracker-empty">{kind === "guest" ? "No guests added for this month yet." : "No boarders yet."}</div>}
  </section>;
}

/* ------------------------------------------------------------------ */
/* Mobile tracker — date nav strip, one card per person for that day   */
/* ------------------------------------------------------------------ */
function MobilePeriod({ label, session, person, day, kind, records, editable, change }) {
  const record = records?.[`${person.id}_${dateKey(day)}_${session}`];
  const sequence = kind === "boarder" ? badgeMap(person.id, records)[`${dateKey(day)}_${session}`] : null;
  return <div className={`mobile-period ${kind}`}>
    <div className="period-label"><span className={`period-icon ${session}`}>{session === "morning" ? "☀️" : "🌙"}</span><div><b>{label}</b><small>{kind === "guest" ? "Add one or many meals" : "Tap to toggle this meal"}</small></div></div>
    <div className="period-control">{kind === "boarder"
      ? <BoarderMealControl session={session} record={record} sequence={sequence} editable={editable} onChange={(patch) => change(person, day, session, patch)} />
      : <GuestMealControl record={record} editable={editable} onChange={(patch) => change(person, day, session, patch)} />}</div>
  </div>;
}
function MobileTrackerSection({ t, title, kind, people, records, editable, change, day }) {
  return <section className={`mobile-tracker-section ${kind}`}>
    <div className="mobile-section-title"><h2>{title}</h2><span>{people.length}</span></div>
    {people.length ? people.map((person) => {
      const total = kind === "boarder" ? boarderTotal(person.id, records) : null;
      const totals = kind === "guest" ? guestTotals(person.id, records) : null;
      return <article key={person.id}>
        <div className="mobile-person-heading"><div><span className="mobile-person-type">{kind === "guest" ? "Guest" : "Boarder"}</span><b>{person.name}</b></div><TotalBadge kind={kind} value={total} totals={totals} t={t} /></div>
        <MobilePeriod label={t("morning")} session="morning" person={person} day={day} kind={kind} records={records} editable={editable} change={change} />
        <MobilePeriod label={t("night")} session="night" person={person} day={day} kind={kind} records={records} editable={editable} change={change} />
      </article>;
    }) : <div className="tracker-empty">{kind === "guest" ? "No guests added yet. Add them from Members." : "No boarders yet."}</div>}
  </section>;
}

function TrackerHero({
  t,
  data,
  boarders,
  guests,
  records,
  indiaNow,
}) {
  const boarderMeals = boarders.reduce(
    (sum, person) => sum + boarderTotal(person.id, records),
    0
  );

  const guestMeals = guests.reduce(
    (sum, person) =>
      sum + guestTotalSum(guestTotals(person.id, records)),
    0
  );

  const indiaDate = new Intl.DateTimeFormat(undefined, {
    timeZone: INDIA_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(indiaNow);

  const indiaTime = new Intl.DateTimeFormat(undefined, {
    timeZone: INDIA_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(indiaNow);

  const indiaMonth = new Intl.DateTimeFormat(undefined, {
    timeZone: INDIA_TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(indiaNow);

  const managerName =
    data.mess?.managerName?.trim() || "Manager";

  return (
    <section className="tracker-hero">
      <div className="hero-orb hero-orb-one" />
      <div className="hero-orb hero-orb-two" />
      <div className="hero-leaf hero-leaf-one">🍃</div>
      <div className="hero-leaf hero-leaf-two">✦</div>



      <div className="tracker-hero-copy">
        <div className="tracker-kicker">
          <BrandMark className="kicker-logo" />

          <span> {indiaDate}</span>

        </div>



        <h1>Meal tracker, made simple.</h1>

        <p>
          Tap a meal to update it instantly. Boarders and guests stay
          together in one clear monthly view.
        </p>

        <div className="tracker-stats">
          <div>
            <strong>{boarders.length}</strong>
            <span>{t("boarder")}</span>
          </div>

          <div>
            <strong>{guests.length}</strong>
            <span>{t("guest")}</span>
          </div>

          <div>
            <strong>{boarderMeals + guestMeals}</strong>
            <span>{t("total")} meals</span>
          </div>
        </div>
      </div>

      {/* Manager — lower right */}
      <div className="hero-manager">
        <span>{t("manager")}</span>
        <strong>{managerName}</strong>
      </div>

      <div className="tracker-hero-art" aria-hidden="true">
        <div className="steam steam-one" />
        <div className="steam steam-two" />
        <div className="steam steam-three" />

        <div className="hero-art-ring ring-one" />
        <div className="hero-art-ring ring-two" />

        <BrandMark className="hero-brand-logo" />

        <div className="pot-art">🍛</div>

        <span className="float-food one">🌶️</span>
        <span className="float-food two">🥬</span>
        <span className="float-food three">🥚</span>
      </div>
    </section>
  );
}

function CurrentMealTracker({ t, data, messId, user }) {
  const indiaNow = useIndiaClock();

  const dateStripRef = useRef(null);
  const dateButtonRefs = useRef({});

  const [day, setDay] = useState(() => todayDay());

  const [indiaDayKey, setIndiaDayKey] = useState(() =>
    getIndiaDateKey()
  );
  useEffect(() => {
    const nextDayKey = getIndiaDateKey(indiaNow);

    if (nextDayKey !== indiaDayKey) {
      const nextDay = Number(getIndiaParts(indiaNow).day);

      setIndiaDayKey(nextDayKey);
      setDay(nextDay);
    }
  }, [indiaNow, indiaDayKey]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const strip = dateStripRef.current;
      const selectedButton = dateButtonRefs.current[day];

      if (!strip || !selectedButton) return;

      const targetLeft =
        selectedButton.offsetLeft -
        (strip.clientWidth - selectedButton.offsetWidth) / 2;

      strip.scrollTo({
        left: Math.max(0, targetLeft),
        behavior: "smooth",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [day]);

  const manager = data.members?.[user.uid]?.role === "manager";
  const people = Object.values(data.people || {}).filter((p) => p.active !== false);
  const boarders = people.filter((p) => data.statuses?.[p.id]?.type !== "guest");
  const guests = people.filter((p) => data.statuses?.[p.id]?.type === "guest");
  const dates = Array.from({ length: monthDays() }, (_, i) => i + 1);

  const change = async (person, dayNum, session, patch) => {
    const date = dateKey(dayNum);
    const ref = doc(db, "messes", messId, "months", monthKey(), "mealRecords", `${person.id}_${date}_${session}`);
    await setDoc(ref, { memberId: person.id, date, session, ...patch, updatedAt: serverTimestamp() }, { merge: true });
  };

  return (
    <>
      <TrackerHero t={t} data={data} boarders={boarders} guests={guests} records={data.records} indiaNow={indiaNow} />

      <div className="legend">
        <span>{t("morning")}</span><i className="sun" />
        <span>{t("night")}</span><i className="night" />
        <span>{t("guest")}</span><i className="guest-dot" />
      </div>

      {/* Desktop: full monthly grid */}
      <div className="clean-desktop">
        <CleanDesktopSection title={t("boarder")} kind="boarder" people={boarders} records={data.records} editable={manager} change={change} t={t} />
        <CleanDesktopSection title={t("guest")} kind="guest" people={guests} records={data.records} editable={manager} change={change} t={t} />
      </div>

      {/* Mobile: date strip + one card per person for the selected day */}
      <div className="clean-mobile">
        <div className="mobile-date-nav">
          <div className="mobile-day-top">
            <div>
              <small className="weekday-label">{weekdayLabel(day)}</small>
              <b className="month-label">{monthLabel()}</b>
            </div>
            <span className="selected-day-chip">Day {day}</span>
          </div>
          <div className="date-strip" ref={dateStripRef}>
            {dates.map((d) => (
              <button
                key={d}
                ref={(el) => { dateButtonRefs.current[d] = el; }}
                className={d === day ? "selected" : ""}
                onClick={() => setDay(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <MobileTrackerSection t={t} title={t("boarder")} kind="boarder" people={boarders} records={data.records} editable={manager} change={change} day={day} />
        <MobileTrackerSection t={t} title={t("guest")} kind="guest" people={guests} records={data.records} editable={manager} change={change} day={day} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Members — boarders + guests management                              */
/* ------------------------------------------------------------------ */
function Modal({ title, children, close }) { return <div className="modal-bg" onClick={close}><div className="modal" onClick={(e) => e.stopPropagation()}><button className="close" onClick={close}><X /></button><h2>{title}</h2>{children}</div></div>; }

function Members({ t, messId, data, manager }) {
  const [name, setName] = useState("");
  const [selectedManagerId, setSelectedManagerId] = useState("");
  const [managerSuccess, setManagerSuccess] = useState(false);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const people = Object.values(data.people || {}).filter(
    (p) => p.active !== false
  );

  const joinedMembers = Object.values(data.members || {}).filter(
    (member) => member.active !== false
  );

  const currentManagerId = data.mess?.currentManagerId;
  const currentManager =
    data.members?.[currentManagerId] ||
    joinedMembers.find((member) => member.role === "manager");
  const managerOptions = joinedMembers.filter(
    (member) => member.uid !== currentManager?.uid && member.id !== currentManager?.id
  );

  const boarders = people.filter(
    (p) => data.statuses?.[p.id]?.type !== "guest"
  );

  const add = async () => {
    if (!name.trim()) return;

    await setDoc(
      doc(db, "messes", messId, "people", createId()),
      {
        name: name.trim(),
        active: true,
        createdAt: serverTimestamp(),
      }
    );

    setName("");
  };

  const transferManager = async () => {
    if (!selectedManagerId) return;

    const nextManager = data.members?.[selectedManagerId];
    if (!nextManager) return;

    await runTransaction(db, async (tx) => {
      const messRef = doc(db, "messes", messId);
      const messSnap = await tx.get(messRef);
      if (!messSnap.exists()) throw new Error("missing-mess");

      const oldManagerId =
        messSnap.data().currentManagerId ||
        currentManager?.uid ||
        currentManager?.id;

      const oldManagerRef = oldManagerId
        ? doc(db, "messes", messId, "members", oldManagerId)
        : null;
      const nextManagerRef = doc(db, "messes", messId, "members", selectedManagerId);
      const nextManagerSnap = await tx.get(nextManagerRef);

      if (!nextManagerSnap.exists()) throw new Error("missing-member");
      if (oldManagerRef) tx.update(oldManagerRef, { role: "member", updatedAt: serverTimestamp() });
      tx.update(nextManagerRef, { role: "manager", active: true, updatedAt: serverTimestamp() });
      tx.update(messRef, { currentManagerId: selectedManagerId, managerName: nextManager.displayName || nextManager.email || "Manager", updatedAt: serverTimestamp() });
    });

    setSelectedManagerId("");
    setManagerSuccess(true);
  };

  return (
    <section className="panel boarder-panel">

      {/* Manager edit section */}
      {manager && (
        <div className="manager-edit-box">

          <div className="section-title">
            <div>
              <span>👑</span>
              <h2>{t("manager")}</h2>
              <p>{t("currentManager")}: {currentManager?.displayName || currentManager?.email || data.mess?.managerName || t("manager")}</p>
            </div>
          </div>


          <div className="manager-transfer-card">
            <label htmlFor="manager-transfer">{t("changeManager")}</label>
            <div className="manager-transfer-controls">
              <select
                id="manager-transfer"
                value={selectedManagerId}
                onChange={(e) => setSelectedManagerId(e.target.value)}
              >
                <option value="">{t("selectMember")}</option>
                {managerOptions.map((member) => (
                  <option key={member.uid || member.id} value={member.uid || member.id}>
                    {member.displayName || member.email || t("member")}
                  </option>
                ))}
              </select>

              <button
                className="cta"
                disabled={!selectedManagerId}
                onClick={transferManager}
              >
                {t("makeManager")}
              </button>
            </div>

          </div>

        </div>
      )}



      <div className="section-title">
        <div>
          <span>👥</span>
          <h2>{t("boarder")}</h2>
          <p>
            {boarders.length} {t("activeMembers")}
          </p>
        </div>
      </div>


      {manager && (
        <div className="inline-form">

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("personPlaceholder")}
          />

          <button
            className="cta"
            onClick={add}
          >
            <Plus />
            {t("addMember")}
          </button>

        </div>
      )}



      <div className="member-list">

        {boarders.map((person) => (

          <article key={person.id}>

            <div className="avatar">
              {person.name.slice(0, 1)}
            </div>

            <div>
              <b>{person.name}</b>
              <small>{t("boarder")}</small>
            </div>


            {manager && (

              <div className="member-actions">

                <button onClick={() => setEditing(person)}>
                  <Pencil size={16} />
                </button>

                <button onClick={() => setRemoving(person)}>
                  <Trash2 size={16} />
                </button>

              </div>

            )}

          </article>

        ))}


        {!boarders.length &&
          <div className="tracker-empty">
            No boarders yet.
          </div>
        }

      </div>



      {editing && (

        <Modal
          title={t("edit")}
          close={() => setEditing(null)}
        >

          <input
            value={editing.name}
            onChange={(e) =>
              setEditing({
                ...editing,
                name: e.target.value
              })
            }
          />


          <button
            className="cta full"
            onClick={async () => {

              await updateDoc(
                doc(
                  db,
                  "messes",
                  messId,
                  "people",
                  editing.id
                ),
                {
                  name: editing.name.trim(),
                  updatedAt: serverTimestamp()
                }
              );

              setEditing(null);

            }}
          >
            {t("save")}
          </button>

        </Modal>

      )}



      {removing && (

        <Modal
          title={t("remove")}
          close={() => setRemoving(null)}
        >

          <p>{t("removeWarning")}</p>


          <button
            className="danger full"
            onClick={async () => {

              await updateDoc(
                doc(
                  db,
                  "messes",
                  messId,
                  "people",
                  removing.id
                ),
                {
                  active: false,
                  removedAt: serverTimestamp()
                }
              );

              setRemoving(null);

            }}
          >
            {t("confirm")}
          </button>


        </Modal>

      )}

      {managerSuccess && (
        <Modal
          title={t("managerChanged")}
          close={() => setManagerSuccess(false)}
        >
          <div className="success-modal-body">
            <Check size={32} />
            <p>{t("managerChanged")}</p>
            <button className="cta full" onClick={() => setManagerSuccess(false)}>
              {t("close")}
            </button>
          </div>
        </Modal>
      )}

    </section>
  );
}

function GuestManagement({ t, messId, data, manager }) {
  const [name, setName] = useState(""), [editing, setEditing] = useState(null), [removing, setRemoving] = useState(null);
  const guests = Object.values(data.people || {}).filter((person) => person.active !== false && data.statuses?.[person.id]?.type === "guest");
  const add = async () => {
    if (!name.trim()) return;
    const person = doc(db, "messes", messId, "people", createId()), batch = writeBatch(db);
    batch.set(person, { name: name.trim(), active: true, createdAt: serverTimestamp() });
    batch.set(doc(db, "messes", messId, "months", monthKey(), "memberStatuses", person.id), { type: "guest", updatedAt: serverTimestamp() });
    await batch.commit(); setName("");
  };
  return <section className="panel guest-panel">
    <div className="section-title"><div><span>🍛</span><h2>{t("guest")}</h2><p>{guests.length}</p></div></div>
    {manager && <div className="inline-form"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("guestName")} /><button className="cta" onClick={add}><Plus />{t("add")}</button></div>}
    <div className="member-list">{guests.map((person) => <article key={person.id}>
      <div className="avatar guest">{person.name.slice(0, 1)}</div>
      <div><b>{person.name}</b><small>{t("guest")}</small></div>
      {manager && <div className="member-actions"><button onClick={() => setEditing(person)}><Pencil size={16} /></button><button onClick={() => setRemoving(person)}><Trash2 size={16} /></button></div>}
    </article>)}
      {!guests.length && <div className="tracker-empty">No guests added for this month yet.</div>}
    </div>
    {editing && <Modal title={t("edit")} close={() => setEditing(null)}>
      <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
      <button className="cta full" onClick={async () => { await updateDoc(doc(db, "messes", messId, "people", editing.id), { name: editing.name.trim(), updatedAt: serverTimestamp() }); setEditing(null); }}>{t("save")}</button>
    </Modal>}
    {removing && <Modal title={t("remove")} close={() => setRemoving(null)}>
      <p>{t("removeWarning")}</p>
      <button className="danger full" onClick={async () => { await updateDoc(doc(db, "messes", messId, "people", removing.id), { active: false, removedAt: serverTimestamp() }); setRemoving(null); }}>{t("confirm")}</button>
    </Modal>}
  </section>;
}

/* ------------------------------------------------------------------ */
/* Bazar / Summary / Settings                                          */
/* ------------------------------------------------------------------ */
function NotesPanel({ t, messId, data, user, manager }) {

  const existing = data.notes?.main;

  const [text, setText] = useState("");
  const [bold, setBold] = useState(false);
  const [color, setColor] = useState("#173b3b");
  const [saved, setSaved] = useState(false);



  // Firestore data আসার পরে state update করবে
  useEffect(() => {

    if (existing) {

      setText(existing.text || "");
      setBold(existing.bold || false);
      setColor(existing.color || "#173b3b");

    }

  }, [existing]);



  const saveNotes = async () => {

    await setDoc(
      doc(
        db,
        "messes",
        messId,
        "notes",
        "main"
      ),
      {
        text,
        bold,
        color,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      },
      {
        merge: true
      }
    );


    // premium save feedback
    setSaved(true);


    setTimeout(() => {

      setSaved(false);

    }, 2500);

  };



  return (

    <section className="panel notes-panel">


      <div className="section-title">

        <div>

          <span>📝</span>

          <h2>
            Important Notes
          </h2>

          <p>
            Keep important mess reminders here
          </p>

        </div>

      </div>



      {manager && (

        <div className="notes-toolbar">


          <button
            className={bold ? "active" : ""}
            onClick={() => setBold(!bold)}
          >
            <b>B</b>
          </button>



          <input

            type="color"

            value={color}

            onChange={(e) =>
              setColor(e.target.value)
            }

          />


        </div>

      )}





      <textarea

        className="notes-area"

        disabled={!manager}

        value={text}

        onChange={(e) =>
          setText(e.target.value)
        }


        style={{

          fontWeight: bold ? 800 : 500,

          color

        }}


        placeholder={

          manager

            ? "Write important notes..."

            : "No notes added yet."

        }


      />




      {manager && (

        <>

          <button

            className="cta notes-save"

            onClick={saveNotes}

          >

            Save Notes

          </button>



          {saved && (

            <div className="notes-success">

              ✓ Notes saved successfully

            </div>

          )}

        </>

      )}



    </section>

  );

}

function Expenses({ t, messId, data, manager }) {
  const [item, setItem] = useState(""), [amount, setAmount] = useState(""), [category, setCategory] = useState("other");
  const expenses = Object.values(data.expenses || {}), total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const add = async () => { if (!item.trim() || !amount) return; await setDoc(doc(db, "messes", messId, "expenses", createId()), { item: item.trim(), amount: Number(amount), category, createdAt: serverTimestamp() }); setItem(""); setAmount(""); };
  return <section className="panel">
    <div className="section-title"><div><span>🧺</span><h2>{t("bazar")}</h2><p>{t("recentExpenses")}</p></div><strong className="rupees">₹{total}</strong></div>
    {manager && <div className="expense-form">
      <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={t("item")} />
      <input value={amount} type="number" onChange={(e) => setAmount(e.target.value)} placeholder={t("amount")} />
      <div className="chips">{["veg", "fish", "meat", "egg", "other"].map((key) => <button className={category === key ? "active" : ""} key={key} onClick={() => setCategory(key)}>{t(key)}</button>)}</div>
      <button className="cta full" onClick={add}>{t("addExpense")}<Plus /></button>
    </div>}
    <div className="expense-list">{expenses.map((expense) => <article key={expense.id}><span>🛍️</span><b>{expense.item}</b><small>{expense.category}</small><strong>₹{expense.amount}</strong></article>)}{!expenses.length && <p>{t("noExpenses")}</p>}</div>
  </section>;
}
function Summary({ t, data }) {
  const people = Object.values(data.people || {}).filter((p) => p.active !== false), statuses = data.statuses || {}, records = Object.values(data.records || {});
  const boarderIds = new Set(people.filter((p) => statuses[p.id]?.type !== "guest").map((p) => p.id)), guestIds = new Set(people.filter((p) => statuses[p.id]?.type === "guest").map((p) => p.id));
  const boarderTotalCount = records.filter((record) => boarderIds.has(record.memberId) && record.status === "on").length;
  const typeTotals = Object.fromEntries(guestTypes.map((type) => [type.key, 0]));
  records.filter((record) => guestIds.has(record.memberId) && record.status === "guest").forEach((record) => { const quantities = guestQuantities(record); guestTypes.forEach((type) => { typeTotals[type.key] += quantities[type.key]; }); });
  Object.values(data.legacyGuestMeals || {}).forEach((record) => { typeTotals[record.type || "veg"] = (typeTotals[record.type || "veg"] || 0) + Number(record.quantity || 1); });
  return <section className="panel">
    <div className="section-title"><div><span>✨</span><h2>{t("summary")}</h2><p>{t("month")}</p></div></div>
    <div className="report-grid">
      <article><strong>{boarderTotalCount}</strong><span>{t("boarder")} meals</span></article>
      <article><strong>{people.length}</strong><span>{t("members")}</span></article>
      <article><strong>{Object.values(typeTotals).reduce((a, b) => a + b, 0)}</strong><span>{t("guestMeals")}</span></article>
      <article><strong>₹{Object.values(data.expenses || {}).reduce((a, x) => a + Number(x.amount || 0), 0)}</strong><span>{t("totalExpense")}</span></article>
    </div>
    <div className="guest-totals"><b>{t("guestMeals")}</b>{guestTypes.map((type) => <span key={type.key}>{type.emoji} {t(type.key)}: <strong>{typeTotals[type.key]}</strong></span>)}</div>
  </section>;
}
function SettingsPanel({ t, messId, data, user, manager, onLeave }) {
  const [name, setName] = useState(data.mess?.name || ""), [copied, setCopied] = useState(false), [leaving, setLeaving] = useState(false), [leaveError, setLeaveError] = useState("");
  const canLeave = !manager && data.mess?.createdBy !== user.uid && data.members?.[user.uid]?.role === "member";
  const regenerate = async () => {
    if (!confirm(t("confirmRegenerate"))) return;
    const old = data.mess?.inviteCode, next = inviteCode(), batch = writeBatch(db);
    batch.set(doc(db, "invites", next), { messId, createdBy: data.mess.createdBy, createdAt: serverTimestamp() });
    batch.update(doc(db, "messes", messId), { inviteCode: next, updatedAt: serverTimestamp() });
    if (old && (await getDoc(doc(db, "invites", old))).exists()) batch.delete(doc(db, "invites", old));
    await batch.commit();
  };
  const leaveMess = async () => {
    setLeaveError("");
    try {
      await runTransaction(db, async (tx) => {
        const messRef = doc(db, "messes", messId);
        const memberRef = doc(db, "messes", messId, "members", user.uid);
        const profileRef = doc(db, "users", user.uid);
        const [messSnap, memberSnap] = await Promise.all([tx.get(messRef), tx.get(memberRef)]);
        if (!messSnap.exists() || !memberSnap.exists()) throw new Error("missing-membership");
        if (memberSnap.data().role === "manager" || messSnap.data().currentManagerId === user.uid || messSnap.data().createdBy === user.uid) throw new Error("manager-cannot-leave");
        tx.update(memberRef, { active: false, leftAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(profileRef, { activeMessId: null, currentMessId: null, role: null, updatedAt: serverTimestamp() }, { merge: true });
      });
      onLeave();
    } catch (error) {
      console.error("leaveMess", error);
      setLeaveError(error.message === "manager-cannot-leave" ? t("managerCannotLeave") : t("error"));
    }
  };
  if (!manager) return <section className="panel">
    <div className="section-title"><div><span>⚙️</span><h2>{t("settings")}</h2><p>{t("memberViewOnly")}</p></div></div>
    <div className="danger-zone-card">
      <div><span className="danger-dot">●</span><div><h3>{t("dangerZone")}</h3><p>{t("leaveMessHint")}</p></div></div>
      <button className="danger" disabled={!canLeave} onClick={() => setLeaving(true)}><LogOut size={16} />{t("leaveMess")}</button>
    </div>
    {!canLeave && <p className="manager-guard-note">{t("managerCannotLeave")}</p>}
    {leaving && <Modal title={t("leaveMess")} close={() => setLeaving(false)}>
      <p>{t("leaveConfirm")}</p>
      <ul className="leave-impact-list">
        <li>{t("mealTrackerAccess")}</li>
        <li>{t("notesAccess")}</li>
        <li>{t("expensesAccess")}</li>
        <li>{t("messDataAccess")}</li>
      </ul>
      {leaveError && <p className="error">{leaveError}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={() => setLeaving(false)}>{t("cancel")}</button>
        <button className="danger" onClick={leaveMess}>{t("leaveMess")}</button>
      </div>
    </Modal>}
  </section>;
  return <section className="panel">
    <div className="section-title"><div><span>⚙️</span><h2>{t("settings")}</h2><p>{t("manager")}: {data.mess?.managerName}</p></div></div>
    <label>{t("messName")}</label>
    <div className="settings-row"><input value={name} onChange={(e) => setName(e.target.value)} /><button className="cta" onClick={() => updateDoc(doc(db, "messes", messId), { name: name.trim(), updatedAt: serverTimestamp() })}>{t("save")}</button></div>
    <label>{t("joinCode")}</label>
    <div className="code-card"><strong>{data.mess?.inviteCode}</strong><button onClick={async () => { await navigator.clipboard.writeText(data.mess?.inviteCode || ""); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Copy size={16} />{copied ? t("copied") : t("copy")}</button><button className="danger-lite" onClick={regenerate}>{t("regenerate")}</button></div>
  </section>;
}

/* ------------------------------------------------------------------ */
/* Dashboard shell                                                     */
/* ------------------------------------------------------------------ */
function Dashboard({ t, lang, setLang, user, messId, data, logout, leaveDone }) {
  const [tab, setTab] = useState("meals");
  const manager = data.members?.[user.uid]?.role === "manager";

  const tabs = [
    ["meals", Utensils, t("meals")],
    ["members", Users, t("members")],
    ["bazar", ShoppingBasket, t("bazar")],
    ["reports", Sparkles, t("reports")],
    ["notes", Pencil, t("notes")],
    ["settings", Settings, t("settings")]
  ];

  const stageRef = useRef(null);
  const contentRef = useRef(null);

  const gesture = useRef({
    active: false,
    locked: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    startTime: 0,
    width: 0
  });

  const animateToTab = (nextIndex) => {
    const currentIndex = tabs.findIndex(([key]) => key === tab);

    if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= tabs.length) {
      return;
    }

    const content = contentRef.current;

    if (!content) {
      setTab(tabs[nextIndex][0]);
      return;
    }

    /*
      Swipe left  -> next tab
      New page enters from RIGHT

      Swipe right -> previous tab
      New page enters from LEFT
    */

    const movingForward = nextIndex > currentIndex;

    // Current page exits in the same direction as the swipe.
    const exitX = movingForward ? "-100%" : "100%";

    // New page starts from the opposite side.
    const enterX = movingForward ? "100%" : "-100%";

    content.style.transition =
      "transform 150ms cubic-bezier(0.22, 1, 0.36, 1)";

    content.style.transform =
      `translate3d(${exitX}, 0, 0)`;

    window.setTimeout(() => {
      setTab(tabs[nextIndex][0]);

      requestAnimationFrame(() => {
        const el = contentRef.current;

        if (!el) return;

        // Put the new page on the correct entering side.
        el.style.transition = "none";
        el.style.transform =
          `translate3d(${enterX}, 0, 0)`;

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const current = contentRef.current;

            if (!current) return;

            current.style.transition =
              "transform 190ms cubic-bezier(0.22, 1, 0.36, 1)";

            current.style.transform =
              "translate3d(0, 0, 0)";
          });
        });
      });
    }, 150);
  };

  const onPointerDown = (e) => {
    if (window.innerWidth > 900) return;

    if (
      e.target.closest(
        "button, a, input, textarea, select, [role='button'], .tabs, .date-strip, .clean-table, .food-picker, .guest-stepper, .modal, [role='dialog']"
      )
    ) {
      return;
    }

    const stage = stageRef.current;
    const content = contentRef.current;

    if (!stage || !content) return;

    gesture.current = {
      active: true,
      locked: false,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      startTime: performance.now(),
      width: stage.clientWidth
    };

    content.style.transition = "none";

    try {
      stage.setPointerCapture(e.pointerId);
    } catch { }
  };

  const onPointerMove = (e) => {
    const g = gesture.current;

    if (!g.active) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (!g.locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;

      // Let normal vertical scrolling win.
      if (Math.abs(dy) > Math.abs(dx) * 1.15) {
        g.active = false;
        return;
      }

      g.locked = true;
    }

    if (Math.abs(dx) <= Math.abs(dy)) return;

    g.currentX = e.clientX;

    const currentIndex = tabs.findIndex(([key]) => key === tab);

    let offset = dx;

    // Only the edges have a small amount of resistance.
    if (currentIndex === 0 && dx > 0) {
      offset = dx * 0.28;
    }

    if (currentIndex === tabs.length - 1 && dx < 0) {
      offset = dx * 0.28;
    }

    const content = contentRef.current;

    if (content) {
      content.style.transform =
        `translate3d(${offset}px, 0, 0)`;
    }

    if (e.cancelable) {
      e.preventDefault();
    }
  };

  const onPointerUp = (e) => {
    const g = gesture.current;

    if (!g.active) return;

    g.active = false;

    const dx = e.clientX - g.startX;
    const elapsed = Math.max(
      performance.now() - g.startTime,
      1
    );

    const distance = Math.abs(dx);
    const velocity = distance / elapsed;

    const currentIndex = tabs.findIndex(([key]) => key === tab);

    // Short, easy flick.
    const distanceThreshold = Math.min(
      g.width * 0.09,
      72
    );

    const velocityThreshold = 0.42;

    const isSwipe =
      distance >= distanceThreshold ||
      velocity >= velocityThreshold;

    let nextIndex = currentIndex;

    if (isSwipe) {
      // Finger moves LEFT -> NEXT tab
      if (
        dx < 0 &&
        currentIndex < tabs.length - 1
      ) {
        nextIndex = currentIndex + 1;
      }

      // Finger moves RIGHT -> PREVIOUS tab
      else if (
        dx > 0 &&
        currentIndex > 0
      ) {
        nextIndex = currentIndex - 1;
      }
    }

    const content = contentRef.current;

    if (nextIndex !== currentIndex) {
      /*
        IMPORTANT:

        nextIndex > currentIndex
          = swipe LEFT
          = current page exits LEFT
          = new page enters RIGHT

        nextIndex < currentIndex
          = swipe RIGHT
          = current page exits RIGHT
          = new page enters LEFT
      */

      const movingForward = nextIndex > currentIndex;

      const exitX = movingForward ? "-100%" : "100%";
      const enterX = movingForward ? "100%" : "-100%";

      if (content) {
        content.style.transition =
          "transform 150ms cubic-bezier(0.22, 1, 0.36, 1)";

        content.style.transform =
          `translate3d(${exitX}, 0, 0)`;
      }

      window.setTimeout(() => {
        setTab(tabs[nextIndex][0]);

        requestAnimationFrame(() => {
          const el = contentRef.current;

          if (!el) return;

          /*
            Position new tab on the opposite side
            without showing the reposition.
          */
          el.style.transition = "none";
          el.style.transform =
            `translate3d(${enterX}, 0, 0)`;

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const current = contentRef.current;

              if (!current) return;

              current.style.transition =
                "transform 190ms cubic-bezier(0.22, 1, 0.36, 1)";

              current.style.transform =
                "translate3d(0, 0, 0)";
            });
          });
        });
      }, 150);

    } else if (content) {
      // Didn't qualify as a swipe — smoothly return.
      content.style.transition =
        "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";

      content.style.transform =
        "translate3d(0, 0, 0)";
    }

    try {
      stageRef.current?.releasePointerCapture(e.pointerId);
    } catch { }
  };

  const onPointerCancel = () => {
    const g = gesture.current;

    if (!g.active) return;

    g.active = false;

    const content = contentRef.current;

    if (content) {
      content.style.transition =
        "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";

      content.style.transform =
        "translate3d(0, 0, 0)";
    }
  };

  const renderTab = () => {
    if (tab === "meals") {
      return (
        <CurrentMealTracker
          t={t}
          data={data}
          messId={messId}
          user={user}
        />
      );
    }

    if (tab === "members") {
      return (
        <div className="members-page">
          <Members
            t={t}
            messId={messId}
            data={data}
            manager={manager}
          />

          <GuestManagement
            t={t}
            messId={messId}
            data={data}
            manager={manager}
          />
        </div>
      );
    }

    if (tab === "bazar") {
      return (
        <Expenses
          t={t}
          messId={messId}
          data={data}
          manager={manager}
        />
      );
    }

    if (tab === "reports") {
      return (
        <Summary
          t={t}
          data={data}
        />
      );
    }

    if (tab === "notes") {
      return (
        <NotesPanel
          t={t}
          messId={messId}
          data={data}
          user={user}
          manager={manager}
        />
      );
    }

    if (tab === "settings") {
      return (
        <SettingsPanel
          t={t}
          messId={messId}
          data={data}
          user={user}
          manager={manager}
          onLeave={() => {
            setTab("meals");
            leaveDone();
          }}
        />
      );
    }

    return null;
  };

  return (
    <main className="tracker">

      <header>
        <div className="dashboard-brand">
          <BrandMark className="dashboard-logo" />

          <div>
            <b>{data.mess?.name}</b>

            <small>
              {t("code")}: {data.mess?.inviteCode}
            </small>
          </div>
        </div>

        <nav>
          <Language
            lang={lang}
            setLang={setLang}
            light
          />

          <button onClick={logout}>
            <LogOut size={16} />
            {t("logout")}
          </button>
        </nav>
      </header>

      <div className="tabs">
        {tabs.map(([key, Icon, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div
        ref={stageRef}
        className="swipe-tab-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          ref={contentRef}
          className="swipe-tab-content"
        >
          {renderTab()}
        </div>
      </div>

    </main>
  );
}

/* ------------------------------------------------------------------ */
/* App root — auth restore, routing (unchanged logic)                  */
/* ------------------------------------------------------------------ */
export default function App() {
  const [lang, setLang] = useState(() => localStorage.getItem("hari-language") || "bn");
  const [user, setUser] = useState(null), [ready, setReady] = useState(false), [screen, setScreen] = useState("landing"), [messId, setMessId] = useState(null);
  const t = useT(lang), data = useMess(messId);
  useEffect(() => { localStorage.setItem("hari-language", lang); }, [lang]);
  useEffect(() => {
    if (!firebaseReady) return undefined;
    let alive = true;
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      const restore = async () => {
        if (!current) { if (alive) { setUser(null); setReady(true); } return; }
        try {
          const profile = doc(db, "users", current.uid), snap = await getDoc(profile);
          let currentMessId =
            snap.data()?.activeMessId ||
            snap.data()?.currentMessId ||
            null;


          // extra safety: find active membership if profile lost
          if (!currentMessId) {

            const memberships = await getDocs(
              collectionGroup(db, "members")
            );

            const found = memberships.docs.find(
              (doc) =>
                doc.id === current.uid &&
                doc.data().active !== false
            );

            if (found) {
              currentMessId = found.ref.parent.parent.id;
            }

          } if (!currentMessId) {
            const legacy = await getDocs(query(collectionGroup(db, "members"), where(documentId(), "==", current.uid), limit(1)));
            const activeLegacy = legacy.docs.find((membership) => membership.data().active !== false);
            if (activeLegacy) currentMessId = activeLegacy.ref.parent.parent.id;
          }
          if (currentMessId) {
            const membership = await getDoc(doc(db, "messes", currentMessId, "members", current.uid));
            if (!membership.exists() || membership.data().active === false) currentMessId = null;
          }
          await setDoc(
            profile,
            {
              uid: current.uid,
              displayName: current.displayName || "",
              email: current.email || "",
              photoURL: current.photoURL || "",

              activeMessId: currentMessId || null,
              currentMessId: currentMessId || null,

              updatedAt: serverTimestamp(),

              ...(snap.exists() && snap.data().createdAt
                ? {}
                : {
                  createdAt: serverTimestamp()
                })
            },
            {
              merge: true
            }
          ); if (alive) { setUser(current); if (currentMessId) { setMessId(currentMessId); setScreen("tracker"); } else setScreen("auth"); }
        } catch (error) { console.error("restoreSession", error); if (alive) { setUser(current); setScreen("auth"); } }
        finally { if (alive) setReady(true); }
      };
      restore();
    });
    return () => { alive = false; unsubscribe(); };
  }, []);
  const enter = (id, next) => { setMessId(id); setScreen(next); };
  const logout = async () => { await signOut(auth); setMessId(null); setScreen("landing"); };
  const login = async () => { try { await signInWithPopup(auth, googleProvider); } catch (error) { console.error("googleLogin", error); } };

  if (!firebaseReady) return <><Language lang={lang} setLang={setLang} /><Screen><div className="auth-card"><h2>{t("noConfig")}</h2><p>{t("noConfigDetail")}</p></div></Screen></>;
  if (!ready || (messId && data.loading)) return <Screen><div className="auth-card"><div className="pot">🍲</div><p>{t("loading")}</p></div></Screen>;
  if (messId && screen === "setup") return <Setup t={t} messId={messId} data={data} user={user} back={() => setScreen("choose")} done={() => setScreen("tracker")} />;
  if (messId && screen === "tracker") return <Dashboard t={t} lang={lang} setLang={setLang} user={user} messId={messId} data={data} logout={logout} leaveDone={() => { setMessId(null); setScreen("choose"); }} />;
  if (screen === "landing") return <Landing t={t} lang={lang} setLang={setLang} go={() => setScreen("auth")} />;
  if (screen === "auth") return <Auth t={t} user={user} login={login} logout={logout} choose={() => setScreen("choose")} />;
  if (screen === "choose") return <Choose t={t} setScreen={setScreen} />;
  if (screen === "create") return <Create t={t} user={user} back={() => setScreen("choose")} onDone={enter} />;
  return <Join t={t} user={user} back={() => setScreen("choose")} onDone={enter} />;
}
