import { useState, type FormEvent } from 'react';

interface Props {
  onSearch: (zip: string) => void;
  initialValue?: string;
  busy?: boolean;
}

export function ZipSearch({ onSearch, initialValue = '', busy = false }: Props) {
  const [value, setValue] = useState(initialValue);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(value);
  }

  return (
    <form className="zip-search" onSubmit={submit}>
      <label className="zip-search__label" htmlFor="zip">
        Enter a Washington ZIP code
      </label>
      <div className="zip-search__row">
        <input
          id="zip"
          className="zip-search__input"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="98101"
          maxLength={10}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="zip-hint"
        />
        <button className="zip-search__button" type="submit" disabled={busy}>
          {busy ? 'Loading…' : 'Show results'}
        </button>
      </div>
      <p id="zip-hint" className="zip-search__hint">
        Washington reports results by county, not by ZIP code. We map your ZIP to the counties it
        covers and show the contests on those ballots.
      </p>
    </form>
  );
}
