import { createElement, type ComponentProps } from 'react';

type Props = ComponentProps<'button'> & { busy?: boolean };

/** Temporary request locks keep their appearance; unavailable actions stay dimmed. */
export function OperationButton({ busy = false, disabled, ...props }: Props) {
  return createElement('button', {
    ...props,
    disabled: busy || disabled,
    'data-busy-lock': busy && !disabled ? true : undefined,
  });
}
