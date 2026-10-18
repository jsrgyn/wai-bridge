ALTER TABLE wa_contacts ADD COLUMN phone_number TEXT CHECK (
  phone_number IS NULL OR (
    length(phone_number) BETWEEN 9 AND 16 AND
    substr(phone_number,1,1)='+' AND
    substr(phone_number,2,1) BETWEEN '1' AND '9' AND
    substr(phone_number,2) NOT GLOB '*[^0-9]*'
  )
);
CREATE INDEX wa_contacts_phone_idx ON wa_contacts(phone_number);
UPDATE wa_contacts SET phone_number=(
  SELECT CASE WHEN COUNT(DISTINCT reference_key)=1 THEN MIN(reference_key) END FROM wa_conversation_identities i
  WHERE i.peer_contact_id=wa_contacts.id AND i.reference_type='PHONE' AND i.source='PROFILE_PHONE'
  AND length(i.reference_key) BETWEEN 9 AND 16
  AND substr(i.reference_key,1,1)='+' AND substr(i.reference_key,2,1) BETWEEN '1' AND '9'
  AND substr(i.reference_key,2) NOT GLOB '*[^0-9]*'
);
