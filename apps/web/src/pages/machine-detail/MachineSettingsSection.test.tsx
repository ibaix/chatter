import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { MachineSettingsSection } from './MachineSettingsSection';

const NEW_HOST = '192.168.1.99';

describe('MachineSettingsSection', () => {
  it('keeps the typed IP address when the server refuses the save, so the user can add the password and save again', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    render(<MachineSettingsSection machine={testMachine({ hasFtpPassword: true })} onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: NEW_HOST } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(onUpdate).toHaveBeenCalledWith('m1', expect.objectContaining({ host: NEW_HOST }));
    expect(screen.getByLabelText('IP address')).toHaveValue(NEW_HOST);
    expect(screen.queryByText('The settings are saved')).not.toBeInTheDocument();
  });
});
