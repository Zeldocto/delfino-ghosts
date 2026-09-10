import { Tooltip } from './Tooltip'

/**
 * Marks a ghost as tool-assisted. Deliberately tiny: one glyph in a fixed
 * gutter so the listing stays aligned whether or not a row has it.
 */
export function TasIndicator({ isTas }: { isTas: boolean }) {
  if (!isTas) return <span aria-hidden="true" />
  return (
    <Tooltip label="TAS">
      <span className="tas-icon" role="img" aria-label="TAS">
        &#128187;
      </span>
    </Tooltip>
  )
}
